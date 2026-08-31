import { Inject, Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { CommandRunner, type CommandResult } from '../../core/process/command-runner.service';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { assertSafeRefName, assertSafeRemoteUrl } from './git-url';
import {
  leaseGitCredential,
  tokenUsernameFor,
  type GitCredential,
} from './git-credentials';

/**
 * Git operations (ADR-019).
 *
 * Every invocation goes through CommandRunner, so no git command is ever built as
 * a shell string. The hardening flags below are applied to every call rather than
 * to the ones that seemed to need them, because a repository is untrusted input
 * and the cost of applying them uniformly is nil.
 */

/**
 * Configuration forced on every git invocation.
 *
 * `core.hooksPath=/dev/null` is the important one: a repository can contain hook
 * scripts, and several git commands run them. Pointing hooksPath at a
 * non-directory means none is ever found, which is a stronger guarantee than
 * trying to enumerate the commands that run hooks.
 */
const HARDENING_ARGS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  // No credential helper may be inherited from anywhere; the askpass lease is
  // the only credential path.
  '-c', 'credential.helper=',
  // Never expand a smudge/clean filter or a diff driver from .gitattributes.
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
  // Do not follow the repository's own alias definitions.
  '-c', 'protocol.ext.allow=never',
  '-c', 'protocol.file.allow=user',
  // Advice output is noise in a parsed result.
  '-c', 'advice.detachedHead=false',
];

export interface GitCloneOptions {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly destination: string;
  /** Directory for the credential helper files. Must be outside `destination`. */
  readonly credentialDirectory: string;
  /** A token for HTTPS or an SSH key, or null for a public remote (ADR-021). */
  readonly credential: GitCredential | null;
  readonly depth?: number;
}

export interface GitCloneResult {
  readonly headCommit: string;
  readonly branch: string;
  readonly durationMs: number;
  /**
   * The host key learned under `accept-new`, so the caller can record it on the
   * connection and reach the strict posture next time.
   */
  readonly learnedHostKey: string | null;
}

export interface GitFileChange {
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export interface GitDiffResult {
  readonly files: readonly GitFileChange[];
  readonly patch: string;
  readonly patchTruncated: boolean;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export class GitCommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly detail: string,
  ) {
    super(`git ${command} failed (exit ${exitCode}): ${detail}`);
    this.name = 'GitCommandError';
  }
}

@Injectable()
export class GitService {
  private readonly logger = new Logger(GitService.name);

  constructor(
    private readonly commands: CommandRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** True when git is present. Called once at boot so a missing git is reported early. */
  async isAvailable(cwd: string): Promise<string | null> {
    const result = await this.commands.run('git', ['--version'], { cwd, timeoutMs: 5000 });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  /**
   * Clones a repository into `destination`.
   *
   * Shallow and single-branch by default: a task needs the tip of one branch, and
   * a full clone of a large Odoo repository is minutes of wall-clock and hundreds
   * of megabytes for no benefit.
   *
   * `--no-recurse-submodules` is explicit rather than relied upon as a default,
   * because `.gitmodules` is attacker-controlled content and submodule handling
   * has been the source of several path-traversal issues in git itself.
   */
  async clone(options: GitCloneOptions): Promise<GitCloneResult> {
    const remote = assertSafeRemoteUrl(options.remoteUrl, {
      allowLocal: this.config.git.allowLocalRemotes,
    });
    const branch = assertSafeRefName(options.branch);
    const depth = options.depth ?? this.config.git.cloneDepth;

    const lease = await leaseGitCredential({
      directory: options.credentialDirectory,
      credential: options.credential,
      hostKeyPolicy: this.config.git.sshHostKeyPolicy,
    });

    // For HTTPS the username goes in the URL and the token is answered by the
    // askpass helper. For SSH the account is already in the normalised URL and the
    // key is supplied through GIT_SSH_COMMAND.
    const cloneUrl =
      remote.scheme === 'https' && options.credential?.kind === 'token'
        ? `https://${tokenUsernameFor(remote.host)}@${remote.host}/${remote.path}`
        : remote.url;

    try {
      const result = await this.commands.run(
        'git',
        [
          ...HARDENING_ARGS,
          'clone',
          '--quiet',
          '--single-branch',
          '--no-recurse-submodules',
          '--no-tags',
          `--depth=${depth}`,
          `--branch=${branch}`,
          // Everything after `--` is an operand, so neither the URL nor the
          // destination can be read as an option even if validation is bypassed.
          '--',
          cloneUrl,
          options.destination,
        ],
        { cwd: options.credentialDirectory, env: lease.env, timeoutMs: this.config.process.maxTimeoutMs },
      );

      if (result.exitCode !== 0) {
        throw new GitCommandError('clone', result.exitCode, summariseFailure(result));
      }

      const headCommit = await this.revParse(options.destination, 'HEAD');
      const learnedHostKey = await this.readLearnedHostKey(lease.knownHostsPath, options.credential);

      this.logger.log(
        `Cloned ${remote.host}/${remote.path} at ${branch} (${headCommit.slice(0, 8)}) in ${result.durationMs}ms`,
      );

      if (learnedHostKey) {
        this.logger.warn(
          `Accepted ${remote.host}'s host key on first contact. It is now recorded, so a later ` +
            'change will be refused - but this first connection was not verified. Supply the host ' +
            'key on the connection to avoid this.',
        );
      }

      return { headCommit, branch, durationMs: result.durationMs, learnedHostKey };
    } finally {
      // Always: a failed clone must not leave a credential helper on disk.
      await lease.release();
    }
  }

  /** Creates a branch at HEAD and checks it out. */
  async createBranch(repositoryPath: string, name: string): Promise<void> {
    const branch = assertSafeRefName(name);
    const result = await this.run(repositoryPath, ['checkout', '-b', branch, '--']);
    if (result.exitCode !== 0) {
      throw new GitCommandError(`checkout -b ${branch}`, result.exitCode, summariseFailure(result));
    }
  }

  async currentBranch(repositoryPath: string): Promise<string> {
    const result = await this.run(repositoryPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (result.exitCode !== 0) {
      throw new GitCommandError('rev-parse --abbrev-ref HEAD', result.exitCode, summariseFailure(result));
    }
    return result.stdout.trim();
  }

  async revParse(repositoryPath: string, ref: string): Promise<string> {
    const result = await this.run(repositoryPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (result.exitCode !== 0) {
      throw new GitCommandError(`rev-parse ${ref}`, result.exitCode, summariseFailure(result));
    }
    return result.stdout.trim();
  }

  /**
   * Working tree status, parsed from the porcelain v1 format.
   *
   * `-z` and NUL-separated records are used rather than line splitting, because a
   * filename may legitimately contain a newline and would otherwise be parsed as
   * two entries.
   */
  async status(repositoryPath: string): Promise<{ clean: boolean; entries: GitFileChange[] }> {
    const result = await this.run(repositoryPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (result.exitCode !== 0) {
      throw new GitCommandError('status', result.exitCode, summariseFailure(result));
    }

    const entries: GitFileChange[] = [];
    for (const record of result.stdout.split('\0')) {
      if (record.length < 4) continue;
      const code = record.slice(0, 2);
      const path = record.slice(3);
      entries.push({ path, change: statusCodeToChange(code), linesAdded: 0, linesRemoved: 0 });
    }

    return { clean: entries.length === 0, entries };
  }

  /**
   * Produces a diff of the working tree against a ref, with statistics and the
   * patch text.
   *
   * Statistics come from `--numstat` and the patch from a second call, rather than
   * being parsed out of one unified diff. Parsing counts out of patch text means
   * writing a diff parser and getting binary files, renames and mode changes
   * wrong; `--numstat` is git's own answer to the same question.
   *
   * `--no-color` and `--no-ext-diff` matter: an external diff driver declared in
   * the repository's `.gitattributes` would otherwise be a command execution.
   */
  async diff(
    repositoryPath: string,
    againstRef: string,
    options: { maxPatchBytes?: number; includeUntracked?: boolean } = {},
  ): Promise<GitDiffResult> {
    const maxPatchBytes = options.maxPatchBytes ?? 256 * 1024;

    // Untracked files are invisible to `git diff`, so a newly created file would
    // not appear in the review. Adding them to the index makes them visible
    // without committing anything.
    if (options.includeUntracked !== false) {
      await this.run(repositoryPath, ['add', '--intent-to-add', '--', '.']);
    }

    const numstat = await this.run(repositoryPath, [
      'diff', '--numstat', '--no-color', '--no-ext-diff', '-M', againstRef, '--',
    ]);
    if (numstat.exitCode !== 0) {
      throw new GitCommandError('diff --numstat', numstat.exitCode, summariseFailure(numstat));
    }

    const nameStatus = await this.run(repositoryPath, [
      'diff', '--name-status', '--no-color', '--no-ext-diff', '-M', againstRef, '--',
    ]);

    const changeByPath = parseNameStatus(nameStatus.stdout);
    const files: GitFileChange[] = [];
    let linesAdded = 0;
    let linesRemoved = 0;

    for (const line of numstat.stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      // A binary file is reported as "-" for both counts.
      const added = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0;
      const removed = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0;
      const path = parts[parts.length - 1];

      linesAdded += added;
      linesRemoved += removed;
      files.push({
        path,
        change: changeByPath.get(path) ?? 'modified',
        linesAdded: added,
        linesRemoved: removed,
      });
    }

    const patchResult = await this.run(repositoryPath, [
      'diff', '--no-color', '--no-ext-diff', '-M', '--unified=3', againstRef, '--',
    ]);

    let patch = patchResult.stdout;
    const patchTruncated = patch.length > maxPatchBytes || patchResult.truncated;
    if (patch.length > maxPatchBytes) {
      patch = `${patch.slice(0, maxPatchBytes)}\n... diff truncated at ${maxPatchBytes} bytes ...\n`;
    }

    return { files, patch, patchTruncated, linesAdded, linesRemoved };
  }

  /**
   * Commits the working tree.
   *
   * The author and committer are set per-invocation rather than written into the
   * clone's config, so the identity is explicit in the audit trail and a
   * repository cannot influence it. The message is passed with `-F -` on stdin
   * rather than `-m`, so a message of any length or content - including one
   * beginning with a hyphen - cannot become an argument.
   */
  async commit(
    repositoryPath: string,
    message: string,
  ): Promise<{ commit: string; filesChanged: number }> {
    const staged = await this.run(repositoryPath, ['add', '--all', '--', '.']);
    if (staged.exitCode !== 0) {
      throw new GitCommandError('add', staged.exitCode, summariseFailure(staged));
    }

    const result = await this.run(repositoryPath, [
      '-c', `user.name=${this.config.git.authorName}`,
      '-c', `user.email=${this.config.git.authorEmail}`,
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '--file=-',
    ], { stdin: message });

    if (result.exitCode !== 0) {
      // "nothing to commit" is an outcome, not a failure: the plan may have
      // produced no net change.
      if (/nothing to commit|no changes added/i.test(result.stdout + result.stderr)) {
        throw new GitCommandError('commit', result.exitCode, 'there was nothing to commit');
      }
      throw new GitCommandError('commit', result.exitCode, summariseFailure(result));
    }

    const commit = await this.revParse(repositoryPath, 'HEAD');
    const changed = await this.run(repositoryPath, ['diff', '--name-only', 'HEAD~1', 'HEAD', '--']);
    const filesChanged = changed.stdout.split('\n').filter((line) => line.trim().length > 0).length;

    return { commit, filesChanged };
  }

  /**
   * Reads back what `accept-new` wrote, so the host key can be recorded.
   *
   * Returns null when a key was already supplied - there is nothing to learn - or
   * when the file is empty, which is what happens on an HTTPS clone.
   */
  private async readLearnedHostKey(
    knownHostsPath: string | null,
    credential: GitCredential | null,
  ): Promise<string | null> {
    if (!knownHostsPath || credential?.hostKey) return null;

    const contents = await readFile(knownHostsPath, 'utf8').catch(() => '');
    const line = contents
      .split(NEWLINE)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && !entry.startsWith('#'));

    return line ?? null;
  }

  /** Runs a git command inside a repository, with the hardening flags applied. */
  private run(
    repositoryPath: string,
    args: readonly string[],
    options: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    return this.commands.run('git', [...HARDENING_ARGS, ...args], {
      cwd: repositoryPath,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
    });
  }
}

/**
 * A short, safe description of a failed command.
 *
 * stderr is truncated and passed through the same URL-credential strip the
 * command logger uses: git's authentication errors quote the remote URL, and a
 * misconfigured URL could carry a token.
 */
function summariseFailure(result: CommandResult): string {
  if (result.timedOut) return 'the command exceeded its timeout and was killed';

  const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
  return (
    detail.replace(/([a-z][a-z0-9+.-]*:[/][/])[^@/\s]+@/gi, '$1[redacted]@') ||
    'no output was produced'
  );
}

/** Maps a porcelain status code to the change kind the platform reports. */
function statusCodeToChange(code: string): GitFileChange['change'] {
  const trimmed = code.trim();
  if (trimmed.includes('D')) return 'deleted';
  if (trimmed.includes('R')) return 'renamed';
  if (trimmed === '??' || trimmed.includes('A')) return 'added';
  return 'modified';
}

/** Maps `git diff --name-status` output to a change kind per path. */
function parseNameStatus(output: string): Map<string, GitFileChange['change']> {
  const changes = new Map<string, GitFileChange['change']>();

  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const status = parts[0];
    // A rename reports both the old and the new path; the new one is what the
    // reviewer cares about.
    const path = parts[parts.length - 1];

    if (status.startsWith('A')) changes.set(path, 'added');
    else if (status.startsWith('D')) changes.set(path, 'deleted');
    else if (status.startsWith('R')) changes.set(path, 'renamed');
    else changes.set(path, 'modified');
  }

  return changes;
}

/**
 * A newline, named rather than escaped.
 *
 * The escape sequence survives poorly through the tooling that generates and
 * patches these files, and a silently broken split is worse than a named constant.
 */
const NEWLINE = String.fromCharCode(10);
