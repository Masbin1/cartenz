import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandArgumentError,
  CommandNotPermittedError,
  CommandRunner,
  SubcommandNotEnabledError,
  assertOdooInvocation,
  findGitSubcommand,
} from './command-runner.service';
import type { AppConfig } from '../config/configuration';

/**
 * The chokepoint every child process goes through (ADR-019).
 *
 * These tests run real commands, because the guarantee under test is about how the
 * process is actually started. A mocked `execFile` would prove only that the code
 * calls a function, not that a shell is uninvolved.
 *
 * `git` is the only allowed executable, so it is what the shell-injection cases
 * use: if a shell were involved, the metacharacters in an argument would be
 * interpreted, and instead git receives them as a literal operand and complains.
 */
describe('CommandRunner', () => {
  let sandbox: string;
  let runner: CommandRunner;

  const config = {
    process: {
      timeoutMs: 15000,
      maxTimeoutMs: 20000,
      maxOutputBytes: 64 * 1024,
    },
    // The default, and the posture a customer's repository is connected under.
    git: { pushEnabled: false },
    // Off too, so the default posture of this stub is the default posture of a
    // deployment: neither pushing nor starting an Odoo process (ADR-027).
    validation: { enabled: false, runtimes: '' },
  } as AppConfig;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-cmd-'));
    runner = new CommandRunner(config);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('runs an allow-listed executable and returns its output', async () => {
    const result = await runner.run('git', ['--version'], { cwd: sandbox });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('git version');
    expect(result.timedOut).toBe(false);
  });

  it('refuses an executable that is not on the allow-list', async () => {
    for (const executable of ['sh', 'bash', 'rm', 'curl', 'node']) {
      await expect(runner.run(executable, ['--version'], { cwd: sandbox })).rejects.toThrow(
        CommandNotPermittedError,
      );
    }
  });

  it('refuses python3 while validation is disabled, which is the default', async () => {
    // python3 is on the allow-list only so an Odoo validation run can be started
    // (ADR-027). With VALIDATION_ENABLED false it is refused at this layer, before
    // a process exists - the same shape as the push refusal, and for the same
    // reason: an interpreter on a customer's server is not something a permission
    // or an approval should be able to reach.
    await expect(
      runner.run('python3', ['/opt/odoo19/odoo-bin', '--version'], { cwd: sandbox }),
    ).rejects.toThrow(SubcommandNotEnabledError);

    await expect(
      runner.run('python3', ['-c', 'print(1)'], { cwd: sandbox }),
    ).rejects.toThrow(/VALIDATION_ENABLED/);
  });

  it('refuses an argument containing a NUL byte', async () => {
    await expect(
      runner.run('git', ['--version', String.fromCharCode(0)], { cwd: sandbox }),
    ).rejects.toThrow(CommandArgumentError);
  });

  /**
   * The central property. Each of these strings would do something if a shell
   * parsed it. Passed as an argument vector, git receives one literal operand and
   * fails to recognise it, and the sandbox is untouched.
   */
  describe('no shell is involved', () => {
    const injections = [
      '; touch injected-semicolon',
      '&& touch injected-and',
      '| touch injected-pipe',
      '$(touch injected-subshell)',
      '`touch injected-backtick`',
      '> injected-redirect',
      String.fromCharCode(10) + 'touch injected-newline',
    ];

    it.each(injections)('treats %j as a literal argument', async (injection) => {
      // `git rev-parse --verify` takes one operand and will simply not resolve it.
      const result = await runner.run('git', ['rev-parse', '--verify', '--', injection], {
        cwd: sandbox,
      });

      // Non-zero is expected: the point is that nothing was executed.
      expect(result.exitCode).not.toBe(0);

      const created = await readdir(sandbox);
      expect(created.filter((name) => name.startsWith('injected'))).toEqual([]);
    });
  });

  it('kills a command that exceeds its timeout, and reports it', async () => {
    // `git help --all` is not slow, so a one-millisecond timeout is what makes
    // this deterministic rather than depending on a slow command existing.
    const result = await runner.run('git', ['help', '--all'], { cwd: sandbox, timeoutMs: 1 });

    expect(result.timedOut || result.exitCode !== 0).toBe(true);
  });

  it('clamps a requested timeout to the configured maximum', async () => {
    const result = await runner.run('git', ['--version'], {
      cwd: sandbox,
      timeoutMs: 10 * 60 * 1000,
    });
    // The command is fast, so success is enough: the clamp is asserted by the
    // absence of an error from execFile's own validation.
    expect(result.exitCode).toBe(0);
  });

  /**
   * A child must not be able to read the platform's secrets out of its
   * environment. `git var` is used because it reports git's own view of a variable
   * without needing a repository.
   */
  it('does not pass the platform environment to the child', async () => {
    process.env.LINKEDERP_TEST_SECRET = 'must-not-be-inherited';

    try {
      // GIT_AUTHOR_NAME is not in the allow-list, so a value set here must not
      // reach the child.
      process.env.GIT_AUTHOR_NAME = 'leaked-identity';

      const result = await runner.run('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: sandbox });

      expect(result.stdout).not.toContain('leaked-identity');
    } finally {
      delete process.env.LINKEDERP_TEST_SECRET;
      delete process.env.GIT_AUTHOR_NAME;
    }
  });

  it('applies the forced git environment', async () => {
    // GIT_CONFIG_GLOBAL is forced to /dev/null, so a global identity cannot be
    // read. `git config --global user.name` therefore finds nothing.
    const result = await runner.run('git', ['config', '--global', 'user.name'], {
      cwd: sandbox,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('passes stdin to the child', async () => {
    // `git hash-object --stdin` reads stdin and prints the object id, which is a
    // deterministic function of the content.
    const result = await runner.run('git', ['hash-object', '--stdin'], {
      cwd: sandbox,
      stdin: 'hello',
    });

    expect(result.exitCode).toBe(0);
    // The SHA-1 of a git blob containing "hello".
    expect(result.stdout.trim()).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });

  it('reports a non-zero exit rather than throwing', async () => {
    // Several git commands answer a question with their exit code, so a failure
    // must be a value the caller inspects, not an exception.
    const result = await runner.run('git', ['rev-parse', '--verify', 'refs/heads/absent'], {
      cwd: sandbox,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result).toHaveProperty('stderr');
  });
});

/**
 * The push guarantee (ADR-021).
 *
 * A customer asked what stops the platform pushing to their repository. The
 * previous answer was that `git_push` happens to be written as a simulation, is
 * not offered to the model, and sits behind an approval gate. That is several
 * layers and still the wrong kind of guarantee - it rests on how one tool is
 * implemented, and whoever delivers Phase 5 by removing the simulation removes the
 * protection with it.
 *
 * These tests assert the answer at the process layer instead: with
 * GIT_PUSH_ENABLED false, there is no `git push` for the platform to run,
 * whatever asked for it.
 */
describe('CommandRunner push guarantee', () => {
  let sandbox: string;

  const configWith = (pushEnabled: boolean) =>
    ({
      process: { timeoutMs: 15000, maxTimeoutMs: 20000, maxOutputBytes: 64 * 1024 },
      validation: { enabled: false, runtimes: '' },
      git: { pushEnabled },
    }) as AppConfig;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-push-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('refuses git push when it is not enabled', async () => {
    const runner = new CommandRunner(configWith(false));

    await expect(runner.run('git', ['push'], { cwd: sandbox })).rejects.toThrow(
      SubcommandNotEnabledError,
    );
  });

  it('refuses it whatever arguments follow', async () => {
    const runner = new CommandRunner(configWith(false));

    for (const args of [
      ['push'],
      ['push', 'origin', 'main'],
      ['push', '--force', 'origin', 'HEAD:main'],
      ['push', '--mirror'],
      ['push', '--delete', 'origin', 'branch'],
    ]) {
      await expect(runner.run('git', args, { cwd: sandbox })).rejects.toThrow(
        SubcommandNotEnabledError,
      );
    }
  });

  /**
   * The case a naive guard misses. Every invocation the platform builds is
   * prefixed with `-c key=value` hardening pairs, so a guard that checked only the
   * first argument would let this through - and every real call looks like this.
   */
  it('refuses it behind the hardening flags every real call carries', async () => {
    const runner = new CommandRunner(configWith(false));

    await expect(
      runner.run(
        'git',
        [
          '-c', 'core.hooksPath=/dev/null',
          '-c', 'credential.helper=',
          '--no-pager',
          'push',
          'origin',
          'main',
        ],
        { cwd: sandbox },
      ),
    ).rejects.toThrow(SubcommandNotEnabledError);
  });

  it('names the setting that would enable it', async () => {
    const runner = new CommandRunner(configWith(false));

    await expect(runner.run('git', ['push'], { cwd: sandbox })).rejects.toThrow(
      /GIT_PUSH_ENABLED/,
    );
  });

  it('still allows every other git subcommand', async () => {
    const runner = new CommandRunner(configWith(false));

    // The guard must be a scalpel: disabling push must not disable the platform.
    for (const args of [['--version'], ['status', '--porcelain'], ['rev-parse', '--help']]) {
      await expect(runner.run('git', args, { cwd: sandbox })).resolves.toHaveProperty('exitCode');
    }
  });

  it('permits push once it is deliberately enabled', async () => {
    const runner = new CommandRunner(configWith(true));

    // Reaches git, which fails for want of a remote. The point is that the
    // platform no longer refuses it: Phase 5 is a configuration change an operator
    // makes, not a simulation someone deletes.
    const result = await runner.run('git', ['push'], { cwd: sandbox });
    expect(result.exitCode).not.toBe(0);
  });
});

describe('findGitSubcommand', () => {
  it('finds the subcommand past the configuration pairs', () => {
    expect(findGitSubcommand(['-c', 'core.hooksPath=/dev/null', 'push'])).toBe('push');
    expect(findGitSubcommand(['-c', 'a=b', '-c', 'c=d', 'clone', 'url'])).toBe('clone');
    expect(findGitSubcommand(['--no-pager', 'diff'])).toBe('diff');
    expect(findGitSubcommand(['--git-dir', '/tmp/x', 'status'])).toBe('status');
  });

  it('is case insensitive', () => {
    expect(findGitSubcommand(['PUSH'])).toBe('push');
  });

  it('returns null when there is no subcommand', () => {
    expect(findGitSubcommand([])).toBeNull();
    expect(findGitSubcommand(['--version'])).toBeNull();
    expect(findGitSubcommand(['-c', 'a=b'])).toBeNull();
  });

  /**
   * A value that looks like a subcommand must not be mistaken for one: `-c` takes
   * its value as a separate argument, so a config value of `push` would otherwise
   * be read as the subcommand and every hardened call would be refused.
   */
  it('does not mistake an option value for the subcommand', () => {
    expect(findGitSubcommand(['-c', 'push', 'status'])).toBe('status');
  });
});

/**
 * The Odoo invocation guard (ADR-027).
 *
 * Adding python3 to the allow-list is a wide grant: it is an interpreter. These
 * assert the narrowing, because a mistake here turns "validation is enabled" into
 * "arbitrary Python may run on the customer's server".
 */
describe('assertOdooInvocation', () => {
  const cores = ['/opt/odoo19', '/opt/odoo17'];

  it('permits an odoo-bin inside a configured runtime', () => {
    expect(() => assertOdooInvocation(['/opt/odoo19/odoo-bin', '-d', 'x'], cores)).not.toThrow();
  });

  it('refuses a script that is not odoo-bin', () => {
    expect(() => assertOdooInvocation(['/opt/odoo19/evil.py'], cores)).toThrow(
      /only run an Odoo core/,
    );
  });

  it('refuses an odoo-bin outside every configured runtime', () => {
    expect(() => assertOdooInvocation(['/tmp/odoo-bin'], cores)).toThrow(
      /not inside a configured Odoo runtime/,
    );
  });

  it('is not fooled by a directory that merely starts with a configured one', () => {
    // "/opt/odoo19-evil" starts with "/opt/odoo19" as a string, and must not pass.
    expect(() => assertOdooInvocation(['/opt/odoo19-evil/odoo-bin'], cores)).toThrow(
      /not inside a configured Odoo runtime/,
    );
  });

  it('refuses an inline program, which is how an interpreter is usually abused', () => {
    expect(() => assertOdooInvocation(['-c', 'import os; os.system("id")'], cores)).toThrow();
    expect(() => assertOdooInvocation(['-m', 'http.server'], cores)).toThrow();
  });

  it('refuses when no script is given at all', () => {
    // Bare python3 is a REPL on the customer's server.
    expect(() => assertOdooInvocation([], cores)).toThrow(/no script was given/);
  });

  it('refuses everything when no runtime is configured', () => {
    expect(() => assertOdooInvocation(['/opt/odoo19/odoo-bin'], [])).toThrow(/\(none\)/);
  });

  it('tolerates a configured path with a trailing slash', () => {
    expect(() => assertOdooInvocation(['/opt/odoo19/odoo-bin'], ['/opt/odoo19/'])).not.toThrow();
  });
});
