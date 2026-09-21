import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from './git.service';
import type { CommandRunner, CommandResult } from '../../core/process/command-runner.service';
import type { AppConfig } from '../../core/config/configuration';

/**
 * Reading a private repository's branches, before any connection exists.
 *
 * The failure this covers: the portal's "Read branches" against a private
 * remote answered `git ls-remote failed (exit 128): fatal: could not read
 * Username for 'https://github.com'. terminal prompts disabled` — a
 * credential-less probe, because the endpoint accepted no credential at all.
 * A private repository cannot be read without one, so the credential has to
 * travel with the probe and be discarded with it.
 */
describe('GitService.listRemoteBranches with a credential', () => {
  const TAB = String.fromCharCode(9);
  const ref = (sha: string, name: string) => `${sha}${TAB}refs/heads/${name}`;

  const configWith = (allowLocal = false) =>
    ({
      git: {
        cloneDepth: 1,
        authorName: 'a',
        authorEmail: 'b',
        allowLocalRemotes: allowLocal,
        pushEnabled: false,
        sshHostKeyPolicy: 'accept-new',
      },
      process: { timeoutMs: 15000, maxTimeoutMs: 20000, maxOutputBytes: 65536 },
    }) as AppConfig;

  /** A runner that answers with fixed stdout and records the env it was given. */
  const runnerWith = (stdout: string, exitCode = 0) => {
    const calls: { executable: string; args: readonly string[]; env?: Record<string, string> }[] =
      [];
    const runner = {
      run: (
        executable: string,
        args: readonly string[],
        options?: { env?: Readonly<Record<string, string>> },
      ): Promise<CommandResult> => {
        calls.push({ executable, args, env: options?.env as Record<string, string> | undefined });
        return Promise.resolve({
          stdout,
          stderr: '',
          exitCode,
          durationMs: 1,
          timedOut: false,
          truncated: false,
        } as CommandResult);
      },
    } as unknown as CommandRunner;

    return { runner, calls };
  };

  it('still refuses, without a credential, so the failure stays honest', async () => {
    // The behaviour the operator hit. Kept as a test because it is the reason
    // the credential parameter exists - not a bug to be silently papered over.
    const { runner, calls } = runnerWith('', 128);
    const service = new GitService(runner, configWith());

    await expect(
      service.listRemoteBranches('https://github.com/Zackattack715/AL3-Boerdery.git'),
    ).rejects.toThrow(/ls-remote/);

    // No SSH command, and prompting stays off: it fails fast rather than hanging.
    expect(calls[0].env?.GIT_SSH_COMMAND).toBeUndefined();
    expect(calls[0].env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('uses an ssh key through GIT_SSH_COMMAND, never on the command line', async () => {
    const { runner, calls } = runnerWith(`${ref('abc', 'main')}\n`);
    const service = new GitService(runner, configWith());

    const branches = await service.listRemoteBranches('git@github.com:Zackattack715/AL3-Boerdery.git', {
      credential: { kind: 'ssh_key', value: 'KEY-MATERIAL', hostKey: null },
    });

    expect(branches).toEqual(['main']);

    // The key reaches ssh by file, so it cannot appear in a process listing.
    const sshCommand = calls[0].env?.GIT_SSH_COMMAND ?? '';
    expect(sshCommand).toContain('IdentitiesOnly=yes');
    expect(sshCommand).toContain('BatchMode=yes');
    // Never `no`: accepting any host key makes the connection MITM-able.
    expect(sshCommand).not.toContain('StrictHostKeyChecking=no');
    expect(sshCommand).not.toContain('KEY-MATERIAL');
    expect(calls[0].args.join(' ')).not.toContain('KEY-MATERIAL');
  });

  it('uses an https token through the askpass helper, not in the URL', async () => {
    const { runner, calls } = runnerWith(`${ref('abc', 'main')}\n`);
    const service = new GitService(runner, configWith());

    await service.listRemoteBranches('https://github.com/o/r.git', {
      credential: { kind: 'token', value: 'TOKEN-MATERIAL', hostKey: null },
    });

    expect(calls[0].env?.GIT_ASKPASS).toBeTruthy();
    expect(calls[0].env?.GIT_TERMINAL_PROMPT).toBe('0');
    // A token in an operand would be visible in `ps` to any user on the host.
    expect(calls[0].args.join(' ')).not.toContain('TOKEN-MATERIAL');
  });

  it('writes the credential files outside the working directory and removes them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cartenz-branches-'));
    const { runner, calls } = runnerWith(`${ref('abc', 'main')}\n`);
    const service = new GitService(runner, configWith());

    try {
      await service.listRemoteBranches('git@github.com:o/r.git', {
        credential: { kind: 'ssh_key', value: 'KEY-MATERIAL', hostKey: null },
        credentialDirectory: directory,
      });

      const sshCommand = calls[0].env?.GIT_SSH_COMMAND ?? '';
      expect(sshCommand).toContain(directory);

      // The lease is released in a finally block, so nothing is left on disk.
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
