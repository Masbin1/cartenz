import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * The username to place in a token clone/push URL for a given host (ADR-059).
 *
 * A project's own choice wins, so an operator whose host wants a real account
 * name — a self-hosted GitLab, a Bitbucket app password — is not stuck with
 * the generic placeholder `tokenUsernameFor` guesses for public hosts.
 */
function httpsUsername(credential: GitCredential | null, host: string): string {
  return credential?.username?.trim() || tokenUsernameFor(host);
}

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
  // GIT_CONFIG_GLOBAL=/dev/null (command-runner.service.ts) means git never
  // reads a gitconfig file, so "safe.directory" cannot be set that way either.
  // Every repository this platform touches is provisioned by a separate root
  // script (create_project) that leaves it owned by "odoo", not "cartenz" -
  // git's ownership check would otherwise refuse every single one of them.
  // Trusting all directories is safe specifically because hooksPath is
  // already neutralised above: the dubious-ownership check exists to stop a
  // hostile repo's hooks running as the invoking user, and that path is
  // already closed.
  '-c', 'safe.directory=*',
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

/** Reached from a request, so it fails fast rather than holding the connection. */
const REMOTE_BRANCH_TIMEOUT_MS = 20_000;

/** A browser renders these in a select; a repository may advertise far more. */
const MAX_REMOTE_BRANCHES = 500;

const REFS_HEADS = 'refs/heads/';

export interface GitCloneOptions {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly destination: string;
  /** Directory for the credential helper files. Must be outside `destination`. */
  readonly credentialDirectory: string;
  /** A token for HTTPS or an SSH key, or null for a public remote (ADR-021). */
  readonly credential: GitCredential | null;
  readonly depth?: number;
  /**
   * Fetch full history instead of a shallow tip (ADR-057).
   *
   * A shallow clone has no common ancestor with a branch fetched alongside it,
   * so `git merge` against that branch fails outright ("refusing to merge
   * unrelated histories") rather than merging. A task needs only the tip and
   * stays shallow; the merge path needs the history, and passes this.
   */
  readonly full?: boolean;
  /**
   * Take every branch, not only the one checked out (ADR-063).
   *
   * A task clones one branch because one branch is all it works on. The
   * long-lived clone a project keeps is the opposite: it is cloned once and then
   * asked for any of the project's branches, so a `--single-branch` clone would
   * make every other branch a network round trip and, without a remote-tracking
   * ref, would leave `behind` unanswerable for all of them.
   */
  readonly allBranches?: boolean;
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

export interface GitPushOptions {
  readonly repositoryPath: string;
  /** The remote to push to. Validated and credential-stripped like the clone. */
  readonly remoteUrl: string;
  /** The branch to push, pushed to the same name on the remote. */
  readonly branch: string;
  /** Directory for the credential helper files. Must be outside the repository. */
  readonly credentialDirectory: string;
  /** A token for HTTPS or an SSH key, or null for a public remote (ADR-021). */
  readonly credential: GitCredential | null;
}

export interface GitPushResult {
  readonly pushed: boolean;
  readonly branch: string;
}

export interface GitPullResult {
  /** `up_to_date` is a successful pull with nothing to take. */
  readonly outcome: 'up_to_date' | 'fast_forwarded';
  readonly branch: string;
  readonly before: string;
  readonly after: string;
  readonly remoteCommit: string;
  readonly commits: number;
  readonly files: readonly string[];
  readonly filesChanged: number;
}

/**
 * A pull the platform refused to make, before or without moving the branch.
 *
 * Thrown rather than returned as a result because neither outcome it names is
 * a pull: `dirty` means the request was made at the wrong moment, `diverged`
 * means the histories no longer share a future. The execution layer records the
 * thrown message as the tool's failure, which is what a person and the model
 * both read.
 */
export class GitPullRefusedError extends Error {
  constructor(
    readonly kind: 'dirty' | 'diverged',
    detail: string,
  ) {
    super(`The pull was refused: ${detail}`);
    this.name = 'GitPullRefusedError';
  }
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
    /**
     * `depth` of 0 or less means the whole history, which is what a request for
     * a full clone asks for either way.
     *
     * A shallow clone is enough for a task, which only needs the tip, but not for
     * reading: an agent asked why a file looks the way it does cannot answer from
     * one commit, and neither can a reviewer. `GIT_CLONE_DEPTH=0` is therefore a
     * supported value rather than a misconfiguration.
     */
    const fullHistory = options.full === true || depth <= 0;

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
        ? `https://${httpsUsername(options.credential, remote.host)}@${remote.host}/${remote.path}`
        : remote.url;

    try {
      const result = await this.commands.run(
        'git',
        [
          ...HARDENING_ARGS,
          'clone',
          '--quiet',
          // One branch per task, or every branch for the clone a project keeps
          // between tasks (ADR-063).
          ...(options.allBranches === true ? [] : ['--single-branch']),
          '--no-recurse-submodules',
          '--no-tags',
          ...(fullHistory ? [] : [`--depth=${depth}`]),
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

  /**
   * The branch names a remote advertises, without cloning it.
   *
   * Exists so a person declaring environments picks from the branches a
   * repository actually has instead of typing one. Typing is where the names
   * diverge: a project declaring `staging` against a repository whose branch is
   * `Staging` fails at clone time, minutes later, with an error about a missing
   * branch rather than about the typo.
   *
   * Read-only and network-touching, and reached from a request rather than the
   * worker, so it carries its own short timeout instead of the process maximum.
   */
  async listRemoteBranches(
    remoteUrl: string,
    options: {
      readonly credential?: GitCredential | null;
      readonly credentialDirectory?: string;
    } = {},
  ): Promise<readonly string[]> {
    const remote = assertSafeRemoteUrl(remoteUrl, {
      allowLocal: this.config.git.allowLocalRemotes,
    });

    // Without a credential there is nothing to write, so any directory serves as
    // the working directory for a command that does not read one. With a
    // credential the files must go somewhere that is ours alone: `mkdtemp` under
    // the system temp, where `release` is the only thing that deletes them.
    const directory = options.credentialDirectory
      ? options.credentialDirectory
      : options.credential && options.credential.value.length > 0
        ? await mkdtemp(join(tmpdir(), 'cartenz-ls-remote-'))
        : tmpdir();
    const lease = await leaseGitCredential({
      directory,
      credential: options.credential ?? null,
      hostKeyPolicy: this.config.git.sshHostKeyPolicy,
    });

    const listUrl =
      remote.scheme === 'https' && options.credential?.kind === 'token'
        ? `https://${httpsUsername(options.credential, remote.host)}@${remote.host}/${remote.path}`
        : remote.url;

    try {
      const result = await this.commands.run(
        'git',
        [...HARDENING_ARGS, 'ls-remote', '--heads', '--refs', '--', listUrl],
        { cwd: directory, env: lease.env, timeoutMs: REMOTE_BRANCH_TIMEOUT_MS },
      );

      if (result.exitCode !== 0) {
        throw new GitCommandError('ls-remote', result.exitCode, summariseFailure(result));
      }

      const branches = result.stdout
        .split(NEWLINE)
        .map((line) => line.split('\t')[1] ?? '')
        .filter((ref) => ref.startsWith(REFS_HEADS))
        .map((ref) => ref.slice(REFS_HEADS.length))
        .filter((name) => name.length > 0);

      // Bounded because the result is returned to a browser, and a repository
      // may have thousands of branches.
      return [...new Set(branches)].sort().slice(0, MAX_REMOTE_BRANCHES);
    } finally {
      await lease.release();
      // Only ours, only when we made it: an explicitly supplied directory
      // belongs to the caller (and to the tests that assert its contents).
      if (directory.startsWith(join(tmpdir(), 'cartenz-ls-remote-'))) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  /**
   * Initialises a new repository on the given branch (ADR-032).
   *
   * `--initial-branch` rather than init-then-rename, so the repository never
   * exists on a branch nobody asked for. The name is checked as a ref name for
   * the same reason every other branch argument is.
   */
  async init(repositoryPath: string, branch: string): Promise<void> {
    const safe = assertSafeRefName(branch);
    const result = await this.run(repositoryPath, ['init', `--initial-branch=${safe}`]);
    if (result.exitCode !== 0) {
      throw new GitCommandError('init', result.exitCode, summariseFailure(result));
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

  /**
   * Creates a branch at HEAD without checking it out (ADR-038).
   *
   * Used by the scaffold to lay down the staging and development branches beside
   * the initial one: the working tree stays on the branch it was on, and the new
   * branch points at the same commit. Idempotent-safe callers should not create a
   * name that already exists; git refuses it, which surfaces as a failed scaffold.
   */
  async addBranch(repositoryPath: string, name: string): Promise<void> {
    const branch = assertSafeRefName(name);
    const result = await this.run(repositoryPath, ['branch', branch, '--']);
    if (result.exitCode !== 0) {
      throw new GitCommandError(`branch ${branch}`, result.exitCode, summariseFailure(result));
    }
  }

  /**
   * The branch names a local working copy has: local branches plus the remote's,
   * with the remote prefix stripped. Used by the on-premise environment picker,
   * where the repository is a local directory rather than a remote URL.
   */
  async listBranches(repositoryPath: string): Promise<readonly string[]> {
    const heads = await this.run(repositoryPath, [
      'for-each-ref', '--format=%(refname:short)', 'refs/heads/',
    ]);
    if (heads.exitCode !== 0) {
      throw new GitCommandError('for-each-ref', heads.exitCode, summariseFailure(heads));
    }

    const remotes = await this.run(repositoryPath, [
      'for-each-ref', '--format=%(refname:short)', 'refs/remotes/',
    ]);
    if (remotes.exitCode !== 0) {
      throw new GitCommandError('for-each-ref', remotes.exitCode, summariseFailure(remotes));
    }

    const names = new Set<string>();
    for (const line of heads.stdout.split('\n')) {
      const name = line.trim();
      if (name.length > 0) names.add(name);
    }
    for (const line of remotes.stdout.split('\n')) {
      const ref = line.trim();
      if (ref.length === 0 || ref === 'origin/HEAD') continue;
      // `origin/Staging` -> `Staging`; any remote name, not just `origin`.
      names.add(ref.replace(/^[^/]+\//, ''));
    }

    return [...names].sort();
  }

  /** Checks out an existing branch. */
  async checkoutBranch(repositoryPath: string, name: string): Promise<void> {
    const branch = assertSafeRefName(name);
    const result = await this.run(repositoryPath, ['checkout', branch, '--']);
    if (result.exitCode !== 0) {
      throw new GitCommandError(`checkout ${branch}`, result.exitCode, summariseFailure(result));
    }
  }

  async currentBranch(repositoryPath: string): Promise<string> {
    const result = await this.run(repositoryPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (result.exitCode !== 0) {
      throw new GitCommandError('rev-parse --abbrev-ref HEAD', result.exitCode, summariseFailure(result));
    }
    return result.stdout.trim();
  }

  /**
   * A ref's commit, or null when it does not resolve.
   *
   * The null-returning counterpart of `revParse`, for the callers that ask about
   * a ref which may legitimately not exist yet - a remote branch before the first
   * fetch, a cache directory before the first clone. Those are questions about
   * state, not failures, and an exception would make the caller's ordinary path
   * the catch block.
   */
  async headOf(repositoryPath: string, ref: string): Promise<string | null> {
    const result = await this.run(repositoryPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  /** Whether `ref` exists in this repository. */
  async hasRef(repositoryPath: string, ref: string): Promise<boolean> {
    return (await this.headOf(repositoryPath, ref)) !== null;
  }

  /**
   * How many commits are reachable from `to` and not from `from`.
   *
   * The number of commits a branch is behind or ahead, depending on which way
   * round the range is given. Reported to a person, so it must be a count of
   * commits rather than a boolean "differs": "3 commits behind" tells an operator
   * whether to look now or later, and "out of date" does not.
   *
   * Returns null when the two refs share no history at all (a shallow clone whose
   * boundary the range crosses, a rewritten remote), because that is not a count
   * and reporting it as one - 0, most likely - would say "up to date" about a
   * branch that cannot be compared.
   */
  async countCommits(repositoryPath: string, from: string, to: string): Promise<number | null> {
    return this.countWithArgs(repositoryPath, ['rev-list', '--count', `${from}..${to}`]);
  }

  /**
   * How much history this repository has: every commit reachable from `ref`.
   *
   * Read to tell a full clone from a shallow one, which is the difference
   * ADR-063 is about - a checkout exists to be read, and `git log` over one
   * commit answers nothing. Null when the count cannot be taken.
   */
  async countReachable(repositoryPath: string, ref: string): Promise<number | null> {
    return this.countWithArgs(repositoryPath, ['rev-list', '--count', ref]);
  };

  private async countWithArgs(
    repositoryPath: string,
    args: readonly string[],
  ): Promise<number | null> {
    const result = await this.run(repositoryPath, [...args]);
    if (result.exitCode !== 0) return null;

    const count = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(count) ? count : null;
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
   * Pushes a branch to the remote it was cloned from, or to an explicit URL.
   *
   * Phase 5 (ADR-021): the outward-facing operation. It uses the same credential
   * lease as clone - an SSH key through GIT_SSH_COMMAND, or an HTTPS token through
   * the askpass helper - so a credential never reaches an argument vector, a
   * config file or a process listing. The branch is pushed to the same name on the
   * remote, never to the default branch; a non-fast-forward push is refused by git
   * itself because no force flag is passed.
   */
  async push(options: GitPushOptions): Promise<GitPushResult> {
    const remote = assertSafeRemoteUrl(options.remoteUrl, {
      allowLocal: this.config.git.allowLocalRemotes,
    });
    const branch = assertSafeRefName(options.branch);

    const lease = await leaseGitCredential({
      directory: options.credentialDirectory,
      credential: options.credential,
      hostKeyPolicy: this.config.git.sshHostKeyPolicy,
    });

    const pushUrl =
      remote.scheme === 'https' && options.credential?.kind === 'token'
        ? `https://${httpsUsername(options.credential, remote.host)}@${remote.host}/${remote.path}`
        : remote.url;

    try {
      const result = await this.commands.run(
        'git',
        [
          ...HARDENING_ARGS,
          'push',
          '--quiet',
          '--atomic',
          '--',
          pushUrl,
          `${branch}:${branch}`,
        ],
        {
          cwd: options.repositoryPath,
          env: lease.env,
          timeoutMs: this.config.process.maxTimeoutMs,
        },
      );

      if (result.exitCode !== 0) {
        throw new GitCommandError('push', result.exitCode, summariseFailure(result));
      }

      this.logger.log(`Pushed ${branch} to ${remote.host}/${remote.path}`);
      return { pushed: true, branch };
    } finally {
      // Always: a failed push must not leave a credential helper on disk.
      await lease.release();
    }
  }

  /**
   * The commit the remote's branch actually points at, or null when the branch
   * does not exist there.
   *
   * Exists because `git push` exiting 0 is not evidence that anything arrived.
   * Pushing a branch that is already at the remote's tip prints "Everything
   * up-to-date" and exits 0, which is indistinguishable from a real push unless
   * the remote is read back. That is not hypothetical: a task whose commit was
   * lost with its workspace pushed a branch identical to the remote's, exited 0,
   * and was reported to the operator as "Branch pushed to the remote repository"
   * with no change on GitHub anywhere. Reading the remote back is what makes that
   * report true or false rather than merely plausible.
   *
   * The credential is used here exactly as it is for a push, so a private
   * repository answers.
   */
  async remoteBranchCommit(
    remoteUrl: string,
    branch: string,
    options: {
      readonly credentialDirectory: string;
      readonly credential: GitCredential | null;
    },
  ): Promise<string | null> {
    const remote = assertSafeRemoteUrl(remoteUrl, {
      allowLocal: this.config.git.allowLocalRemotes,
    });
    const safeBranch = assertSafeRefName(branch);

    const lease = await leaseGitCredential({
      directory: options.credentialDirectory,
      credential: options.credential,
      hostKeyPolicy: this.config.git.sshHostKeyPolicy,
    });

    const listUrl =
      remote.scheme === 'https' && options.credential?.kind === 'token'
        ? `https://${httpsUsername(options.credential, remote.host)}@${remote.host}/${remote.path}`
        : remote.url;

    try {
      const result = await this.commands.run(
        'git',
        [
          ...HARDENING_ARGS,
          'ls-remote',
          '--refs',
          '--',
          listUrl,
          `${REFS_HEADS}${safeBranch}`,
        ],
        {
          cwd: options.credentialDirectory,
          env: lease.env,
          timeoutMs: REMOTE_BRANCH_TIMEOUT_MS,
        },
      );

      if (result.exitCode !== 0) {
        throw new GitCommandError('ls-remote', result.exitCode, summariseFailure(result));
      }

      const line = result.stdout.split(NEWLINE).find((entry) => entry.trim().length > 0);
      if (!line) return null;

      const commit = line.split('\t')[0]?.trim() ?? '';
      return commit.length > 0 ? commit : null;
    } finally {
      await lease.release();
    }
  }

  /**
   * Refreshes every branch a remote advertises into `refs/remotes/origin/*`
   * (ADR-063).
   *
   * The counterpart of `fetchBranch` for a clone that outlives a task: the
   * project's clone is cloned once and then asked for any of the project's
   * branches, so the remote-tracking refs are what make "N commits behind"
   * answerable for a branch that is not checked out. Nothing is merged and no
   * working tree moves - this reads the remote's state.
   *
   * The forced refspec (`+`) means a branch the remote rewrote still updates
   * its remote-tracking ref; no local branch follows it, which is what keeps
   * this safe while a task's worktree is checked out on one of them.
   */
  async fetchAll(
    repositoryPath: string,
    remoteUrl: string,
    options: {
      readonly credentialDirectory: string;
      readonly credential: GitCredential | null;
    },
  ): Promise<void> {
    const remote = assertSafeRemoteUrl(remoteUrl, {
      allowLocal: this.config.git.allowLocalRemotes,
    });

    const lease = await leaseGitCredential({
      directory: options.credentialDirectory,
      credential: options.credential,
      hostKeyPolicy: this.config.git.sshHostKeyPolicy,
    });

    const fetchUrl =
      remote.scheme === 'https' && options.credential?.kind === 'token'
        ? `https://${httpsUsername(options.credential, remote.host)}@${remote.host}/${remote.path}`
        : remote.url;

    try {
      const result = await this.commands.run(
        'git',
        [
          ...HARDENING_ARGS,
          'fetch',
          '--quiet',
          '--prune',
          '--no-tags',
          '--',
          fetchUrl,
          '+refs/heads/*:refs/remotes/origin/*',
        ],
        { cwd: repositoryPath, env: lease.env, timeoutMs: this.config.process.maxTimeoutMs },
      );

      if (result.exitCode !== 0) {
        throw new GitCommandError('fetch', result.exitCode, summariseFailure(result));
      }
    } finally {
      await lease.release();
    }
  }

  /**
   * Checks a branch out in a working tree of its own, attached to an existing
   * clone (ADR-063).
   *
   * This is how a task gets a directory without downloading the repository
   * again: the objects live once, in the project's clone, and each task gets a
   * working tree over them. `-B` points the local branch at `startPoint` - the
   * remote-tracking ref, so a task starts from the remote's tip exactly as a
   * fresh clone would.
   *
   * git refuses a branch already checked out in another worktree, so two tasks
   * on one branch cannot share a working tree; the second fails with git's own
   * message. `--force` is deliberately not passed: it is precisely the flag
   * that would override that refusal.
   */
  async worktreeAdd(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    fromRemoteBranch: string,
  ): Promise<void> {
    const safeBranch = assertSafeRefName(branch);
    // Built here rather than accepted as a ref, so a caller cannot start a
    // worktree from an arbitrary revision expression.
    const startPoint = `refs/remotes/origin/${assertSafeRefName(fromRemoteBranch)}`;
    const result = await this.run(repositoryPath, [
      'worktree',
      'add',
      '--quiet',
      '-B',
      safeBranch,
      '--',
      worktreePath,
      startPoint,
    ]);
    if (result.exitCode !== 0) {
      throw new GitCommandError('worktree add', result.exitCode, summariseFailure(result));
    }
  }

  /**
   * Detaches a clone's own checkout to a branch's tip (ADR-063).
   *
   * Detached on purpose: a branch checked out here would be unavailable to
   * every task worktree, because git allows a branch in one worktree only. The
   * files are still there to read and analyse; no branch is held.
   *
   * `source` picks which tip: `'local'` for the project's own local branch -
   * the one a task may have committed to and not pushed, so this is what a
   * person reading the clone should see - and `'remote'` for the
   * remote-tracking ref, used right after a clone when no local branch exists
   * yet.
   */
  async detachAt(
    repositoryPath: string,
    branch: string,
    source: 'local' | 'remote',
  ): Promise<void> {
    const safeBranch = assertSafeRefName(branch);
    const ref = source === 'local' ? `refs/heads/${safeBranch}` : `refs/remotes/origin/${safeBranch}`;
    const result = await this.run(repositoryPath, ['checkout', '--quiet', '--detach', ref]);
    if (result.exitCode !== 0) {
      throw new GitCommandError('checkout --detach', result.exitCode, summariseFailure(result));
    }
  }

  /**
   * A working tree of its own on a branch that already exists locally
   * (ADR-063).
   *
   * The counterpart to `worktreeAdd`: no `-B`, so an existing local branch keeps
   * exactly the commits it has - a previous task's work included. Fails when the
   * branch has no local ref yet; callers create one with `branchAt` first, which
   * is equally non-destructive.
   */
  async worktreeAttach(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    const safeBranch = assertSafeRefName(branch);
    const result = await this.run(repositoryPath, [
      'worktree',
      'add',
      '--quiet',
      '--',
      worktreePath,
      safeBranch,
    ]);
    if (result.exitCode !== 0) {
      throw new GitCommandError('worktree add', result.exitCode, summariseFailure(result));
    }
  }

  /**
   * Creates a local branch at a remote branch's tip, when it does not exist
   * (ADR-063).
   *
   * Existence is checked rather than the command's failure ignored, because a
   * local branch that exists must keep its own position: a task part-way through
   * work has commits this would otherwise throw away.
   */
  async branchAt(repositoryPath: string, name: string, fromRemoteBranch: string): Promise<void> {
    const safeBranch = assertSafeRefName(name);
    if (await this.hasRef(repositoryPath, `refs/heads/${safeBranch}`)) return;

    const startPoint = `refs/remotes/origin/${assertSafeRefName(fromRemoteBranch)}`;
    const result = await this.run(repositoryPath, ['branch', safeBranch, startPoint, '--']);
    if (result.exitCode !== 0) {
      throw new GitCommandError('branch', result.exitCode, summariseFailure(result));
    }
  }

  /**
   * Moves a local branch to a new commit, but only when it is still at the
   * commit the caller last saw (ADR-063).
   *
   * A compare-and-swap: used to fast-forward a branch nobody has checked out,
   * where "nobody" was established by reading `git worktree list` moments
   * earlier. Passing the expected old value makes the two atomic - if a task took
   * the branch into a worktree in between, this fails instead of moving a branch
   * out from under it.
   */
  async updateBranchRef(
    repositoryPath: string,
    branch: string,
    to: string,
    expectedCurrent: string,
  ): Promise<void> {
    const safeBranch = assertSafeRefName(branch);
    const result = await this.run(repositoryPath, [
      'update-ref',
      `refs/heads/${safeBranch}`,
      to,
      expectedCurrent,
    ]);
    if (result.exitCode !== 0) {
      throw new GitCommandError('update-ref', result.exitCode, summariseFailure(result));
    }
  }

  /**
   * The `.git` directory of the repository this working tree belongs to, or
   * null when there is none (ADR-063).
   *
   * How release finds the clone to detach from: a task's directory is a
   * worktree whose metadata lives in the project's clone, so removing the
   * directory must also drop the worktree's record - a record left behind pins
   * its branch and would refuse every later task over a directory nobody can
   * see. For an ordinary per-task clone this returns its own `.git`, which is
   * how the caller tells the two apart: a main working tree is never detached.
   */
  async gitCommonDir(repositoryPath: string): Promise<string | null> {
    const result = await this.run(repositoryPath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (result.exitCode !== 0) return null;
    const dir = result.stdout.trim();
    return dir.length > 0 ? dir : null;
  }

  /**
   * Detaches a task's working tree from the clone; the clone itself stays.
   *
   * `--force` here discards the worktree's uncommitted changes, which is what
   * releasing a task has always meant - the per-task clone this replaces was
   * deleted with `rm -rf`. A worktree already gone is the goal state.
   */
  async worktreeRemove(repositoryPath: string, worktreePath: string): Promise<void> {
    await this.run(repositoryPath, ['worktree', 'remove', '--force', '--', worktreePath]);
    // Whatever the removal said, drop records whose directory is gone: a stale
    // record pins its branch, and every later task on that branch would then be
    // refused over a directory nobody can see.
    await this.run(repositoryPath, ['worktree', 'prune']);
  }

  /** The branches currently checked out in any worktree of this clone. */
  async worktreeBranches(repositoryPath: string): Promise<Map<string, string>> {
    /**
     * Pruned first, because a worktree directory can disappear without git
     * hearing about it - a `rm -rf` from `reclaimOrphans`, a workspace released
     * after its record was lost, a killed worker. Its record would still pin the
     * branch, so `worktree add` on that branch would be refused over a directory
     * nobody can see. Pruning drops exactly the records whose directory is gone,
     * so this read leaves live worktrees alone.
     */
    await this.run(repositoryPath, ['worktree', 'prune']);

    const result = await this.run(repositoryPath, ['worktree', 'list', '--porcelain']);
    const branches = new Map<string, string>();
    if (result.exitCode !== 0) return branches;

    let path: string | null = null;
    for (const line of result.stdout.split(NEWLINE)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/') && path) {
        branches.set(line.slice('branch refs/heads/'.length), path);
      }
    }
    return branches;
  }

  /**
   * Fetches one branch from a remote into a local repository, without checking
   * it out. Used ahead of a merge (ADR-057): the workspace is cloned at the
   * *target* branch's tip, and the *source* branch is fetched into it so the
   * merge has both tips to work with, without a second clone.
   */
  async fetchBranch(
    repositoryPath: string,
    remoteUrl: string,
    branch: string,
    options: {
      readonly credentialDirectory: string;
      readonly credential: GitCredential | null;
    },
  ): Promise<void> {
    const remote = assertSafeRemoteUrl(remoteUrl, {
      allowLocal: this.config.git.allowLocalRemotes,
    });
    const safeBranch = assertSafeRefName(branch);

    const lease = await leaseGitCredential({
      directory: options.credentialDirectory,
      credential: options.credential,
      hostKeyPolicy: this.config.git.sshHostKeyPolicy,
    });

    const fetchUrl =
      remote.scheme === 'https' && options.credential?.kind === 'token'
        ? `https://${httpsUsername(options.credential, remote.host)}@${remote.host}/${remote.path}`
        : remote.url;

    try {
      const result = await this.commands.run(
        'git',
        [
          ...HARDENING_ARGS,
          'fetch',
          '--quiet',
          // No --depth here: a fetch that deepens an already-shallow clone in
          // one step needs --unshallow or --depth=<bigger>, and silently
          // fetching another shallow tip is exactly how a merge ends up with
          // no common ancestor. The clone that precedes this is full (see
          // GitCloneOptions.full), so this fetch inherits that history.
          '--',
          fetchUrl,
          `${safeBranch}:refs/remotes/origin/${safeBranch}`,
        ],
        { cwd: repositoryPath, env: lease.env, timeoutMs: this.config.process.maxTimeoutMs },
      );

      if (result.exitCode !== 0) {
        throw new GitCommandError('fetch', result.exitCode, summariseFailure(result));
      }
    } finally {
      await lease.release();
    }
  }

  /**
   * Brings the checked-out branch up to date with a branch on the remote, by
   * fast-forward only (the `git_pull` tool).
   *
   * Fetch, then `merge --ff-only`, and nothing else - no rebase, no merge
   * commit, no `-X theirs`. A pull that cannot fast-forward (the local branch
   * has commits the remote does not, or the remote was rewritten) is refused by
   * git itself with the working tree untouched, and reported as that refusal.
   * Resolving a divergence is a decision about whose work wins, and no person
   * is in this loop to make it.
   *
   * A working tree with uncommitted changes is refused before anything is
   * fetched. git would fast-forward around unrelated local edits, but a pull
   * that sometimes proceeds and sometimes refuses depending on which files the
   * remote touched is harder to reason about than one that always wants a clean
   * tree - and the implementation instruction asks for the pull first.
   *
   * The fetch refspec is forced (`+`) so a remote-tracking ref that the remote
   * rewrote is still updated; whether the *branch* may follow it is then decided
   * by the fast-forward check, which is the check that matters.
   *
   * Shallow clones are fine: verified against a depth-1 clone, a fetch brings
   * the new commits down to the shallow boundary and the fast-forward succeeds,
   * and a diverged history is refused exactly as in a full clone.
   */
  async pullFastForward(
    repositoryPath: string,
    remoteUrl: string,
    branch: string,
    options: {
      readonly credentialDirectory: string;
      readonly credential: GitCredential | null;
    },
  ): Promise<GitPullResult> {
    const remote = assertSafeRemoteUrl(remoteUrl, {
      allowLocal: this.config.git.allowLocalRemotes,
    });
    const safeBranch = assertSafeRefName(branch);
    const trackingRef = `refs/remotes/origin/${safeBranch}`;

    const status = await this.status(repositoryPath);
    if (!status.clean) {
      throw new GitPullRefusedError(
        'dirty',
        `the working tree has uncommitted changes in ${status.entries.length} file(s), ` +
          'so nothing was pulled. Pull before changing files.',
      );
    }

    const before = await this.revParse(repositoryPath, 'HEAD');

    const lease = await leaseGitCredential({
      directory: options.credentialDirectory,
      credential: options.credential,
      hostKeyPolicy: this.config.git.sshHostKeyPolicy,
    });

    const fetchUrl =
      remote.scheme === 'https' && options.credential?.kind === 'token'
        ? `https://${httpsUsername(options.credential, remote.host)}@${remote.host}/${remote.path}`
        : remote.url;

    try {
      const fetched = await this.commands.run(
        'git',
        [
          ...HARDENING_ARGS,
          'fetch',
          '--quiet',
          '--no-tags',
          '--',
          fetchUrl,
          `+refs/heads/${safeBranch}:${trackingRef}`,
        ],
        { cwd: repositoryPath, env: lease.env, timeoutMs: this.config.process.maxTimeoutMs },
      );

      if (fetched.exitCode !== 0) {
        throw new GitCommandError('fetch', fetched.exitCode, summariseFailure(fetched));
      }
    } finally {
      await lease.release();
    }

    const remoteCommit = await this.revParse(repositoryPath, trackingRef);

    if (remoteCommit === before) {
      return {
        outcome: 'up_to_date',
        branch: safeBranch,
        before,
        after: before,
        remoteCommit,
        commits: 0,
        files: [],
        filesChanged: 0,
      };
    }

    const merged = await this.run(repositoryPath, [
      'merge',
      '--ff-only',
      '--no-edit',
      '--quiet',
      trackingRef,
      '--',
    ]);

    if (merged.exitCode !== 0) {
      // Whatever git's reason - diverged history, unrelated histories after a
      // rewrite - the branch has not moved, and saying so is the result.
      const current = await this.revParse(repositoryPath, 'HEAD').catch(() => before);
      if (current !== before) {
        throw new GitCommandError('merge --ff-only', merged.exitCode, summariseFailure(merged));
      }
      throw new GitPullRefusedError(
        'diverged',
        `${safeBranch} cannot be fast-forwarded to the remote (${remoteCommit.slice(0, 8)}): ` +
          `${summariseFailure(merged)}. The branch was left at ${before.slice(0, 8)}; ` +
          'the local and remote histories have diverged and must be reconciled by a person.',
      );
    }

    const after = await this.revParse(repositoryPath, 'HEAD');

    const counted = await this.run(repositoryPath, ['rev-list', '--count', `${before}..${after}`]);
    const commits = counted.exitCode === 0 ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0;

    const names = await this.run(repositoryPath, [
      'diff', '--name-only', '--no-color', '--no-ext-diff', before, after, '--',
    ]);
    const allFiles =
      names.exitCode === 0
        ? names.stdout.split(NEWLINE).map((line) => line.trim()).filter((line) => line.length > 0)
        : [];

    return {
      outcome: 'fast_forwarded',
      branch: safeBranch,
      before,
      after,
      remoteCommit,
      commits,
      files: allFiles.slice(0, 200),
      filesChanged: allFiles.length,
    };
  }

  /**
   * Merges an already-fetched ref into the currently checked-out branch
   * (ADR-057).
   *
   * `strategy: 'theirs'` resolves every conflicting hunk in favour of the ref
   * being merged in, so this never stops to ask for manual resolution - there
   * is no human in this loop to ask. `--no-ff` always produces a merge commit,
   * even when a fast-forward was possible, so the promotion is visible as its
   * own commit in the target branch's history rather than silently rewriting
   * it to match the source.
   */
  async merge(
    repositoryPath: string,
    ref: string,
    message: string,
  ): Promise<{ commit: string }> {
    const result = await this.run(repositoryPath, [
      '-c', `user.name=${this.config.git.authorName}`,
      '-c', `user.email=${this.config.git.authorEmail}`,
      'merge',
      '--no-ff',
      '-X', 'theirs',
      '--no-gpg-sign',
      '-m', message,
      '--',
      ref,
    ]);

    if (result.exitCode !== 0) {
      throw new GitCommandError('merge', result.exitCode, summariseFailure(result));
    }

    const commit = await this.revParse(repositoryPath, 'HEAD');
    return { commit };
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

  /**
   * The URL of a repository's own `origin`, or null when it has none.
   *
   * On-premise operates on a directory a person selected, not on a clone the
   * platform made, so the platform has no remote URL of its own to push to
   * (ADR-028). The repository already carries one in `.git/config`, which the
   * hardened environment can still read: GIT_CONFIG_NOSYSTEM and
   * GIT_CONFIG_GLOBAL suppress the system and user files, not the repository's.
   *
   * Returned unvalidated. The caller passes it to `push`, where
   * `assertSafeRemoteUrl` applies the same checks it applies to every other
   * remote - a URL out of a customer's config file is untrusted input.
   */
  async originUrl(repositoryPath: string): Promise<string | null> {
    const result = await this.run(repositoryPath, ['remote', 'get-url', 'origin']);
    if (result.exitCode !== 0) return null;

    const url = result.stdout.trim();
    return url.length > 0 ? url : null;
  }

  /**
   * Points a named remote at a URL, replacing whatever it pointed at (ADR-041).
   *
   * Idempotent on purpose: project creation is retried after a failure, and
   * `remote add` against a name that already exists fails, so the existing remote is
   * removed first and the removal's exit code deliberately ignored — "no such
   * remote" is the normal case for a freshly scaffolded repository.
   *
   * The URL passes through the same `assertSafeRemoteUrl` a push uses, so nothing
   * can be stored here that a push would later refuse, and a URL carrying an
   * embedded credential is refused here rather than written into the repository's
   * own config. The credential for a push is supplied per push, through the lease.
   */
  async setRemote(repositoryPath: string, name: string, url: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      throw new Error(`"${name}" is not a usable git remote name.`);
    }
    const remote = assertSafeRemoteUrl(url, { allowLocal: this.config.git.allowLocalRemotes });

    await this.run(repositoryPath, ['remote', 'remove', name]);
    const added = await this.run(repositoryPath, ['remote', 'add', name, remote.url]);
    if (added.exitCode !== 0) {
      throw new GitCommandError(`remote add ${name}`, added.exitCode, summariseFailure(added));
    }

    // Read back rather than trusting the exit code: the point of this call is that
    // the remote a push will use is the one that was asked for.
    const stored = await this.run(repositoryPath, ['remote', 'get-url', name]);
    if (stored.exitCode !== 0 || stored.stdout.trim() !== remote.url) {
      throw new GitCommandError(
        `remote get-url ${name}`,
        stored.exitCode,
        `the remote was set to "${stored.stdout.trim() || 'nothing'}" instead of "${remote.url}"`,
      );
    }
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
