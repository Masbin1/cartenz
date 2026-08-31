import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseGitCredential, tokenUsernameFor } from './git-credentials';

/**
 * The credential lease (ADR-014, ADR-021).
 *
 * The property under test is where a credential does *not* appear: not in an
 * argument vector, not in `.git/config`, and not on disk after the operation. So
 * the assertions are about the filesystem and the environment, on a real temporary
 * directory.
 */
describe('leaseGitCredential', () => {
  let directory: string;
  const KEY = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'abc123',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'linkederp-cred-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const lease = (
    credential: Parameters<typeof leaseGitCredential>[0]['credential'],
    hostKeyPolicy: 'yes' | 'accept-new' = 'accept-new',
    dir?: string,
  ) => leaseGitCredential({ directory: dir ?? directory, credential, hostKeyPolicy });

  it('disables prompting even with no credential, so a private remote fails fast', async () => {
    // Without this git blocks forever on a terminal read nothing will answer.
    const result = await lease(null);

    expect(result.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(result.knownHostsPath).toBeNull();
  });

  describe('token', () => {
    const token = { kind: 'token' as const, value: 'ghp_secrettoken0123456789' };

    it('puts the token in the environment, never in an argument or the helper', async () => {
      const result = await lease(token);

      expect(result.env.LINKEDERP_GIT_TOKEN).toBe(token.value);

      const script = await readFile(result.env.GIT_ASKPASS, 'utf8');
      expect(script).not.toContain('ghp_secrettoken');
      expect(script).toContain('LINKEDERP_GIT_TOKEN');
    });

    it('writes the helper unreadable to anyone else', async () => {
      const result = await lease(token);
      const info = await stat(result.env.GIT_ASKPASS);

      // The mode passed to writeFile is subject to umask, so it is set twice.
      expect(info.mode & 0o777).toBe(0o700);
    });

    it('removes the helper on release', async () => {
      const result = await lease(token);
      const path = result.env.GIT_ASKPASS;

      await result.release();

      await expect(stat(path)).rejects.toThrow();
    });
  });

  describe('ssh key', () => {
    const sshKey = (hostKey?: string) => ({
      kind: 'ssh_key' as const,
      value: KEY,
      ...(hostKey ? { hostKey } : {}),
    });

    it('writes the key at 0600 and supplies only its path to ssh', async () => {
      const result = await lease(sshKey());

      expect(result.env.GIT_SSH_COMMAND).toContain('-i');
      expect(result.env.GIT_SSH_COMMAND).not.toContain('abc123');

      const info = await stat(join(directory, 'id_ssh'));
      expect(info.mode & 0o777).toBe(0o600);
    });

    it('appends the trailing newline OpenSSH requires', async () => {
      await lease(sshKey());
      const written = await readFile(join(directory, 'id_ssh'), 'utf8');

      expect(written.endsWith('\n')).toBe(true);
    });

    /**
     * Without IdentitiesOnly, ssh offers every key the host machine's agent holds,
     * so a clone could succeed using a credential belonging to someone else.
     */
    it('uses only the key supplied', async () => {
      expect((await lease(sshKey())).env.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes');
    });

    /**
     * The host machine's known_hosts must not decide trust: what someone once
     * accepted on this machine is not a decision the platform should inherit.
     */
    it('consults only its own known_hosts file', async () => {
      const result = await lease(sshKey());

      expect(result.env.GIT_SSH_COMMAND).toContain('GlobalKnownHostsFile=/dev/null');
      expect(result.knownHostsPath).toBe(join(directory, 'known_hosts'));
    });

    /** `no` accepts any host key and makes the connection man-in-the-middleable. */
    it('never disables host key checking', async () => {
      for (const policy of ['yes', 'accept-new'] as const) {
        const result = await lease(sshKey(), policy);

        expect(result.env.GIT_SSH_COMMAND).not.toContain('StrictHostKeyChecking=no');
        expect(result.env.GIT_SSH_COMMAND).toContain(`StrictHostKeyChecking=${policy}`);
      }
    });

    /**
     * A recorded host key means the strict posture is available, so it is used
     * regardless of the configured default: there is no reason to stay lenient once
     * the key is known.
     */
    it('uses strict checking whenever a host key is recorded', async () => {
      const result = await lease(
        sshKey('git.odoo.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI'),
        'accept-new',
      );

      expect(result.env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');
      expect(await readFile(join(directory, 'known_hosts'), 'utf8')).toContain('git.odoo.com');
    });

    it('fails rather than prompting, because nothing is watching', async () => {
      const result = await lease(sshKey());

      expect(result.env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
      expect(result.env.GIT_TERMINAL_PROMPT).toBe('0');
    });

    it('removes the key and the known_hosts file on release', async () => {
      const result = await lease(sshKey());
      await result.release();

      await expect(stat(join(directory, 'id_ssh'))).rejects.toThrow();
      await expect(stat(join(directory, 'known_hosts'))).rejects.toThrow();
    });

    /**
     * git splits GIT_SSH_COMMAND on whitespace, so an unquoted path containing a
     * space would become two arguments. The paths contain none today, which is
     * exactly why it is worth handling before the workspace root is configurable.
     */
    it('quotes the paths it embeds', async () => {
      const spaced = await mkdtemp(join(tmpdir(), 'linkederp cred '));
      try {
        const result = await lease(sshKey(), 'accept-new', spaced);
        expect(result.env.GIT_SSH_COMMAND).toContain(`-i "${join(spaced, 'id_ssh')}"`);
      } finally {
        await rm(spaced, { recursive: true, force: true });
      }
    });
  });
});

describe('tokenUsernameFor', () => {
  it('uses the fixed username each host expects', () => {
    expect(tokenUsernameFor('github.com')).toBe('x-access-token');
    expect(tokenUsernameFor('gitlab.com')).toBe('oauth2');
    expect(tokenUsernameFor('git.odoo.com')).toBe('git');
  });
});
