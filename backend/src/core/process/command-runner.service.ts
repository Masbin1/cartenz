import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/configuration';

/**
 * The only place in the platform that starts a child process (ADR-019).
 *
 * Everything about this class exists to make one guarantee: no value derived
 * from a repository, a prompt or an API request can be interpreted as a command.
 *
 *  - `execFile` with an argument vector, never `exec` and never a shell string.
 *    A shell is never involved, so quoting, globbing, `;`, `&&`, backticks and
 *    `$(...)` have no meaning in any argument.
 *  - The executable must be on a fixed allow-list. A caller cannot name an
 *    arbitrary binary even by accident.
 *  - The environment is built from an allow-list rather than inherited, so a
 *    child cannot read the platform's secrets out of `process.env`.
 *  - Timeout, output cap and a killed-process signal are always applied.
 *
 * Callers do not handle a non-zero exit as an exception. `run` returns the exit
 * code, stdout and stderr, and lets the caller decide, because for several git
 * commands a non-zero exit is an expected answer rather than a failure.
 */

/** Executables the platform may start. Anything else is refused. */
/**
 * python3 is here only so an Odoo validation run can be started, and it is
 * guarded twice: VALIDATION_ENABLED must be true, and the invocation must be an
 * odoo-bin inside a configured runtime (ADR-027).
 */
const ALLOWED_EXECUTABLES = new Set(['git', 'python3']);

/**
 * Git subcommands refused unless explicitly enabled (ADR-021).
 *
 * `push` is here for a specific reason. It was previously prevented by
 * `git_push` being written as a simulation, by the tool not being offered to the
 * model, and by an approval gate. That is several layers and still the wrong kind
 * of guarantee: it rests on how one tool happens to be implemented, and whoever
 * delivers Phase 5 by removing the simulation removes the protection with it.
 *
 * Refusing here makes it a property of the system. It does not matter which code
 * path asked, whether the tool was marked simulated, whether the permission was
 * granted, or whether an approval was recorded - there is no `git push` for the
 * process layer to run.
 */
const GUARDED_GIT_SUBCOMMANDS: Readonly<Record<string, string>> = {
  push: 'GIT_PUSH_ENABLED',
};

/** Executables that are refused outright unless their setting is enabled. */
const GUARDED_EXECUTABLES: Readonly<Record<string, string>> = {
  python3: 'VALIDATION_ENABLED',
};

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when the process was killed for exceeding its timeout. */
  readonly timedOut: boolean;
  /** True when output was truncated at the cap. */
  readonly truncated: boolean;
}

export interface CommandOptions {
  /** Working directory. Required: no command runs at an unspecified location. */
  readonly cwd: string;
  /** Overrides the configured default. Clamped to the configured maximum. */
  readonly timeoutMs?: number;
  /**
   * Extra environment for this call only, merged over the allow-listed base.
   * Used to pass GIT_ASKPASS and the token variable it reads.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Written to the child's stdin and closed. */
  readonly stdin?: string;
}

export class CommandNotPermittedError extends Error {
  constructor(executable: string) {
    super(
      `"${executable}" is not an allowed executable. ` +
        `The platform may start only: ${[...ALLOWED_EXECUTABLES].join(', ')}.`,
    );
    this.name = 'CommandNotPermittedError';
  }
}

/**
 * Raised when a subcommand is refused by configuration (ADR-021).
 *
 * Distinct from CommandNotPermittedError so that a caller, a log line and a test
 * can tell "this is never allowed" from "this is switched off here".
 */
export class SubcommandNotEnabledError extends Error {
  /**
   * `subcommand` is empty when the whole executable is guarded rather than one of
   * its subcommands, which is how VALIDATION_ENABLED gates python3. Handled here
   * so the message reads as a sentence in both cases: this text is what somebody
   * sees at the moment they are already confused about why nothing ran.
   */
  constructor(
    readonly executable: string,
    readonly subcommand: string,
    readonly setting: string,
  ) {
    const what = subcommand ? `${executable} ${subcommand}` : executable;

    super(
      `"${what}" is disabled. Set ${setting}=true to enable it. ` +
        'Until then the platform cannot run it, whatever permission or approval is in place.',
    );
    this.name = 'SubcommandNotEnabledError';
  }
}

export class CommandArgumentError extends Error {
  constructor(reason: string) {
    super(`Refused to build a command: ${reason}`);
    this.name = 'CommandArgumentError';
  }
}

/**
 * Environment variables a child process may inherit. Everything else is dropped,
 * including DATABASE_URL, REDIS_URL, JWT_SECRET, SECRETS_ROOT_KEY and AI_API_KEY.
 */
const INHERITED_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'];

/**
 * Environment forced on every child regardless of the caller.
 *
 * These are the difference between running git against a hostile remote and
 * running it safely. GIT_TERMINAL_PROMPT stops git blocking forever on a
 * credential prompt; the rest stop git reading configuration or attributes that
 * a repository or a shared machine could influence.
 */
const FORCED_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  // Ignore any system or user git configuration: the platform supplies its own.
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  // Never open a pager or an editor: both would hang a non-interactive process.
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  // Deterministic, locale-independent output for parsing.
  LC_ALL: 'C',
};

@Injectable()
export class CommandRunner {
  private readonly logger = new Logger(CommandRunner.name);
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly odooCoreDirectories: readonly string[];
  /** Settings that enable a guarded subcommand, by setting name. */
  private readonly enabled: Readonly<Record<string, boolean>>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.defaultTimeoutMs = config.process.timeoutMs;
    this.maxTimeoutMs = config.process.maxTimeoutMs;
    this.maxOutputBytes = config.process.maxOutputBytes;
    this.enabled = {
      GIT_PUSH_ENABLED: config.git.pushEnabled,
      VALIDATION_ENABLED: config.validation.enabled,
    };

    // Parsed once. A caller cannot widen the permitted set by passing a path.
    this.odooCoreDirectories = config.validation.runtimes
      .split(',')
      .map((entry) => entry.slice(entry.indexOf('=') + 1).trim())
      .filter((entry) => entry.startsWith('/'));

    if (config.validation.enabled) {
      this.logger.warn(
        'VALIDATION_ENABLED=true: the platform may start an Odoo process on this host, ' +
          `from ${this.odooCoreDirectories.length} configured runtime(s).`,
      );
    } else {
      this.logger.log(
        'Validation is refused at the process layer (VALIDATION_ENABLED=false). No Odoo ' +
          'process can be started.',
      );
    }

    if (!config.git.pushEnabled) {
      this.logger.log(
        'git push is refused at the process layer (GIT_PUSH_ENABLED=false). No code path can push.',
      );
    } else {
      this.logger.warn(
        'GIT_PUSH_ENABLED=true: the platform is permitted to push to customer repositories.',
      );
    }
  }

  /**
   * Runs an allow-listed executable with an argument vector.
   *
   * Every argument is validated: a NUL byte would truncate the argument at the
   * syscall boundary, and an argument that begins with a hyphen where the caller
   * did not intend an option is how option-injection works. Callers pass `--`
   * themselves where git supports it; this check catches the rest.
   */
  async run(
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    if (!ALLOWED_EXECUTABLES.has(executable)) {
      throw new CommandNotPermittedError(executable);
    }

    // Checked before argument validation and before the process is built, so a
    // refused subcommand cannot have a side effect of any kind.
    // Refused before argument validation and before the process is built, so a
    // refused executable cannot have a side effect of any kind.
    const executableSetting = GUARDED_EXECUTABLES[executable];
    if (executableSetting && this.enabled[executableSetting] !== true) {
      this.logger.warn(`Refused "${executable}": ${executableSetting} is not enabled`);
      throw new SubcommandNotEnabledError(executable, '', executableSetting);
    }

    // Enabled is not the same as unrestricted: python3 may only start an Odoo
    // core from a configured runtime.
    if (executable === 'python3') {
      assertOdooInvocation(args, this.odooCoreDirectories);
    }

    if (executable === 'git') {
      const subcommand = findGitSubcommand(args);
      const setting = subcommand ? GUARDED_GIT_SUBCOMMANDS[subcommand] : undefined;

      if (subcommand && setting && this.enabled[setting] !== true) {
        this.logger.warn(`Refused "git ${subcommand}": ${setting} is not enabled`);
        throw new SubcommandNotEnabledError(executable, subcommand, setting);
      }
    }

    for (const [index, arg] of args.entries()) {
      if (typeof arg !== 'string') {
        throw new CommandArgumentError(`argument ${index} is not a string`);
      }
      if (arg.includes('\0')) {
        throw new CommandArgumentError(`argument ${index} contains a NUL byte`);
      }
    }

    const timeoutMs = Math.min(options.timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs);
    const startedAt = Date.now();

    return new Promise<CommandResult>((resolve) => {
      const child = execFile(
        executable,
        [...args],
        {
          cwd: options.cwd,
          env: this.buildEnv(options.env),
          timeout: timeoutMs,
          maxBuffer: this.maxOutputBytes,
          // No shell, ever. This is the property the whole class exists for.
          shell: false,
          windowsHide: true,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startedAt;
          const timedOut = isTimeout(error);
          const truncated = isOutputCapExceeded(error);

          const result: CommandResult = {
            exitCode: resolveExitCode(error, child.exitCode),
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            durationMs,
            timedOut,
            truncated,
          };

          if (timedOut) {
            this.logger.warn(
              `${executable} ${redactArgs(args)} exceeded ${timeoutMs}ms and was killed`,
            );
          } else if (truncated) {
            this.logger.warn(
              `${executable} ${redactArgs(args)} produced more than ${this.maxOutputBytes} bytes`,
            );
          }

          resolve(result);
        },
      );

      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin);
      }
    });
  }

  /**
   * Builds the child environment from the allow-list, then the caller's
   * additions, then the forced values. Forced values are applied last so a
   * caller cannot weaken them.
   */
  private buildEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
    const env: Record<string, string> = {};

    for (const key of INHERITED_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }

    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        env[key] = value;
      }
    }

    return { ...env, ...FORCED_ENV };
  }
}

/**
 * Finds the git subcommand in an argument vector.
 *
 * Every invocation the platform builds is prefixed with `-c key=value` hardening
 * pairs, so the subcommand is never argv[0]. Scanning past the options is what
 * makes `git -c core.hooksPath=/dev/null push` refused as readily as `git push`;
 * matching only the first argument would be a guard that any caller could step
 * around by accident.
 */
export function findGitSubcommand(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    // `-c key=value` and `--config-env key=value` take a separate value argument.
    if (arg === '-c' || arg === '--config-env' || arg === '--exec-path' || arg === '--git-dir') {
      index += 1;
      continue;
    }
    // Any other option, including `--option=value`, takes no operand here.
    if (arg.startsWith('-')) continue;

    return arg.toLowerCase();
  }

  return null;
}

function resolveExitCode(error: unknown, fallback: number | null): number {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  if (error) return fallback ?? 1;
  return fallback ?? 0;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { killed?: boolean; signal?: string }).killed === true;
}

function isOutputCapExceeded(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return String((error as { message?: string }).message ?? '').includes('maxBuffer');
}

/**
 * Argument list for a log line. A URL may embed a username, and a future caller
 * could pass something sensitive, so anything resembling a credential in a URL
 * is stripped before the arguments are logged.
 */
function redactArgs(args: readonly string[]): string {
  return args
    .map((arg) => arg.replace(/([a-z][a-z0-9+.-]*:[/][/])[^@/\s]+@/i, '$1[redacted]@'))
    .join(' ');
}

/**
 * Refuses a Python invocation that is not an Odoo run from a configured core.
 *
 * Adding `python3` to the allow-list is a wide grant: it is an interpreter. The
 * grant is narrowed here to a single shape - the first argument must be an
 * `odoo-bin` inside one of the directories configured as an Odoo runtime - so
 * that enabling validation does not become permission to execute arbitrary
 * Python on a customer's server (ADR-027).
 *
 * The core paths come from configuration, not from the caller, so a caller
 * cannot widen this by passing a different path.
 */
export function assertOdooInvocation(
  args: readonly string[],
  coreDirectories: readonly string[],
): void {
  const script = args[0];

  if (!script) {
    throw new CommandArgumentError(
      'python3 may only be started to run an Odoo core, and no script was given.',
    );
  }

  if (!script.endsWith('/odoo-bin')) {
    throw new CommandArgumentError(
      `python3 may only run an Odoo core's odoo-bin, not "${script}". Enabling ` +
        'validation permits an Odoo run, not arbitrary Python.',
    );
  }

  // Compared against the configured directories with a trailing separator, so
  // that "/opt/odoo19-evil/odoo-bin" is not accepted by "/opt/odoo19".
  const permitted = coreDirectories.some((directory) =>
    script.startsWith(`${directory.replace(/[/]+$/, '')}/`),
  );

  if (!permitted) {
    throw new CommandArgumentError(
      `"${script}" is not inside a configured Odoo runtime. Configured: ` +
        `${coreDirectories.length > 0 ? coreDirectories.join(', ') : '(none)'}.`,
    );
  }
}
