import { readProjectGitCredential } from './project-git-access';

/**
 * The per-project branch probe (`GET /projects/:id/remote-branches`) resolved
 * the project's Git access and then ran `ls-remote` without its credential:
 * `Permission denied (publickey)` on an Odoo.sh project whose SSH key was
 * correctly configured and used by every other git operation. The probe now
 * goes through this helper, so a resolved secret always becomes a credential.
 */
describe('readProjectGitCredential', () => {
  const secrets = (value = 'KEY-MATERIAL') => {
    const read = jest.fn((ref: string) => Promise.resolve(`${value}:${ref}`));
    return { read };
  };

  it('turns a resolved ssh key into the credential git presents', async () => {
    const store = secrets();

    const credential = await readProjectGitCredential(store, {
      secretRef: 'secret-1',
      credentialKind: 'ssh_key',
      sshHostKey: 'github.com ssh-ed25519 AAAA',
      credentialUsername: null,
    });

    expect(store.read).toHaveBeenCalledWith('secret-1');
    expect(credential).toEqual({
      kind: 'ssh_key',
      value: 'KEY-MATERIAL:secret-1',
      hostKey: 'github.com ssh-ed25519 AAAA',
      username: null,
    });
  });

  it('carries a token and its username for an https remote', async () => {
    const credential = await readProjectGitCredential(secrets('TOKEN'), {
      secretRef: 'secret-2',
      credentialKind: 'token',
      sshHostKey: null,
      credentialUsername: 'x-access-token',
    });

    expect(credential).toMatchObject({ kind: 'token', username: 'x-access-token' });
  });

  it('returns null, without touching the secret store, when no tier supplied a secret', async () => {
    const store = secrets();

    const credential = await readProjectGitCredential(store, {
      secretRef: null,
      credentialKind: 'token',
      sshHostKey: null,
      credentialUsername: null,
    });

    expect(credential).toBeNull();
    expect(store.read).not.toHaveBeenCalled();
  });
});
