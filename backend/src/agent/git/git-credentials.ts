import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Credential release for a git operation (ADR-014, ADR-019, ADR-021).
 *
 * The problem this solves: git needs a credential, and every obvious way of giving
 * it one leaks it.
 *
 *  - In the URL (`https://x:TOKEN@host/...`) - written into `.git/config` by
 *    clone, and visible in `ps` for the lifetime of the command.
 *  - On the command line (`-c credential.helper='...TOKEN...'`) - visible in `ps`
 *    to any user on the host.
 *  - In a config file inside the clone - persists after the operation, and sits in
 *    a directory the agent's file tools can read.
 *
 * Two credential kinds are supported, because the two common cases need different
 * mechanisms: a token over HTTPS, which is how a GitHub-linked project is reached,
 * and an SSH key, which is how Odoo.sh's native remote is reached.
 *
 * Both are written into the workspace *metadata* directory, which is a sibling of
 * the clone rather than inside it, so the agent's file tools - contained to the
 * repository - cannot read them. Both are removed in a `finally` block, so a
 * failed operation does not leave a credential on disk.
 */

/** Environment variable the askpass script reads. Never logged. */
const TOKEN_ENV_KEY = 'LINKEDERP_GIT_TOKEN';

/**
 * The askpass contract: git calls the program with a prompt on argv and takes the
 * first line of stdout as the answer. Answering unconditionally is correct here,
 * because the only credential this helper is ever configured with is the one for
 * the remote being contacted.
 */
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  '# Written by LinkedERP for a single git operation, then removed.',
  '# Reads the token from the environment so that it never appears in argv.',
  `printf '%s' "$${TOKEN_ENV_KEY}"`,
  '',
].join('\n');

export type CredentialKind = 'token' | 'ssh_key';

export interface GitCredential {
  readonly kind: CredentialKind;
  /** The token, or the SSH private key in OpenSSH format. */
  readonly value: string;
  /** known_hosts line for the remote, where one is recorded. */
  readonly hostKey?: string | null;
}

export interface GitCredentialLease {
  /** Environment additions for the git invocation. */
  readonly env: Readonly<Record<string, string>>;
  /** Removes every file written. Always called, including on failure. */
  readonly release: () => Promise<void>;
  /**
   * Path of the known_hosts file, so the caller can read back what `accept-new`
   * learned and record it on the connection.
   */
  readonly knownHostsPath: string | null;
}

export interface LeaseOptions {
  /** Directory for the helper files. Must be outside the repository clone. */
  readonly directory: string;
  readonly credential: GitCredential | null;
  /** `yes` requires a recorded host key; `accept-new` trusts first contact. */
  readonly hostKeyPolicy: 'yes' | 'accept-new';
}

/** Prepares a credential lease, or a no-credential one that still disables prompting. */
export async function leaseGitCredential(options: LeaseOptions): Promise<GitCredentialLease> {
  const { directory, credential, hostKeyPolicy } = options;

  if (!credential || credential.value.length === 0) {
    // No credential: still disable prompting, so a private remote fails fast with
    // an authentication error rather than hanging on a terminal read.
    return {
      env: { GIT_TERMINAL_PROMPT: '0' },
      release: async () => undefined,
      knownHostsPath: null,
    };
  }

  return credential.kind === 'ssh_key'
    ? leaseSshKey(directory, credential, hostKeyPolicy)
    : leaseToken(directory, credential.value);
}

async function leaseToken(directory: string, token: string): Promise<GitCredentialLease> {
  const askpassPath = join(directory, 'askpass.sh');

  await writeFile(askpassPath, ASKPASS_SCRIPT, { encoding: 'utf8', mode: 0o700 });
  // Set explicitly as well: the mode passed to writeFile is subject to the process
  // umask, and this file must not be group or world readable.
  await chmod(askpassPath, 0o700);

  return {
    env: {
      GIT_ASKPASS: askpassPath,
      [TOKEN_ENV_KEY]: token,
      GIT_TERMINAL_PROMPT: '0',
    },
    release: async () => {
      await rm(askpassPath, { force: true });
    },
    knownHostsPath: null,
  };
}

/**
 * Prepares an SSH key and a host key policy (ADR-021).
 *
 * The options below are the substance of this function, and the reason each is
 * present is worth stating:
 *
 *  - `IdentitiesOnly=yes` - use *only* the key supplied. Without it ssh offers
 *    every key the host machine's agent holds, so a clone could succeed using a
 *    credential belonging to someone else entirely.
 *  - `UserKnownHostsFile` pointing at our own file, plus `GlobalKnownHostsFile`
 *    at /dev/null - the host machine's known_hosts is not consulted, so trust does
 *    not depend on what someone once accepted on this machine.
 *  - `StrictHostKeyChecking` - never `no`. `no` accepts any host key and makes the
 *    connection trivially man-in-the-middleable. `yes` is correct and needs a
 *    recorded key; `accept-new` trusts first contact and is a stated compromise.
 *  - `BatchMode=yes` - fail rather than prompt, because nothing is watching.
 */
async function leaseSshKey(
  directory: string,
  credential: GitCredential,
  hostKeyPolicy: 'yes' | 'accept-new',
): Promise<GitCredentialLease> {
  const keyPath = join(directory, 'id_ssh');
  const knownHostsPath = join(directory, 'known_hosts');

  // OpenSSH refuses a key file without a trailing newline.
  const key = credential.value.endsWith('\n') ? credential.value : `${credential.value}\n`;

  await writeFile(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  await chmod(keyPath, 0o600);

  // Written even when empty: ssh must have a file to consult, and an empty one
  // under `yes` produces a clean refusal rather than a confusing error.
  await writeFile(knownHostsPath, credential.hostKey ? `${credential.hostKey.trim()}\n` : '', {
    encoding: 'utf8',
    mode: 0o600,
  });

  // A recorded host key means the strict posture is available regardless of the
  // configured default, so use it: there is no reason to be lenient once the key
  // is known.
  const policy = credential.hostKey ? 'yes' : hostKeyPolicy;

  const sshCommand = [
    'ssh',
    '-i',
    quote(keyPath),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    `StrictHostKeyChecking=${policy}`,
    '-o',
    `UserKnownHostsFile=${quote(knownHostsPath)}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'ConnectTimeout=20',
  ].join(' ');

  return {
    env: { GIT_SSH_COMMAND: sshCommand, GIT_TERMINAL_PROMPT: '0' },
    release: async () => {
      await rm(keyPath, { force: true });
      await rm(knownHostsPath, { force: true });
    },
    knownHostsPath,
  };
}

/**
 * Quotes a path for GIT_SSH_COMMAND.
 *
 * git splits this value on whitespace, so a workspace path containing a space
 * would otherwise become two arguments. The paths are platform-generated and
 * currently contain none, which is exactly why it is worth quoting now rather than
 * discovering it when the workspace root becomes configurable.
 */
function quote(path: string): string {
  return `"${path.replace(/(["\$`])/g, '\$1')}"`;
}

/**
 * The username to place in a remote URL for a token-authenticated HTTPS clone.
 *
 * A username is not a secret, and both GitHub and GitLab accept a fixed one with
 * the token supplied as the password. Putting it in the URL means git knows which
 * credential to ask for and does not prompt for the username as well.
 */
export function tokenUsernameFor(host: string): string {
  if (host.endsWith('github.com')) return 'x-access-token';
  if (host.includes('gitlab')) return 'oauth2';
  return 'git';
}
