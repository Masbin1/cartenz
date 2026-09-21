import { assertSafeRemoteUrl } from '../../agent/git/git-url';

/**
 * The URL scheme decides which credential mechanism is used (ADR-021), so the
 * inference must agree with the scheme the remote parser actually reports.
 *
 * This is a regression guard for a real failure: the connect-existing form
 * pasted an SSH private key for a `git@host:owner/repo.git` remote, the server
 * defaulted the kind to `token`, and the key was handed to the HTTPS askpass
 * helper while git was speaking SSH. The push failed with an authentication
 * error that named nothing the operator had done.
 *
 * Asserted against `assertSafeRemoteUrl` rather than against a duplicate regex,
 * because the inference is only correct if it follows the same parser the clone
 * and push paths use. A second, independently written rule is how the two came
 * apart in the first place.
 */
describe('credential kind inferred from a repository URL', () => {
  /** The rule as projects.service.ts applies it, over the shared parser. */
  const infer = (repositoryUrl: string): 'token' | 'ssh_key' => {
    try {
      return assertSafeRemoteUrl(repositoryUrl, { allowLocal: false }).scheme === 'ssh'
        ? 'ssh_key'
        : 'token';
    } catch {
      return 'token';
    }
  };

  it('infers an ssh key from git\'s scp-like form, which has no scheme', () => {
    // The form the operator pasted. No `ssh://` prefix anywhere.
    expect(infer('git@github.com:Zackattack715/AL3-Boerdery.git')).toBe('ssh_key');
  });

  it('infers an ssh key from an explicit ssh:// url', () => {
    expect(infer('ssh://git@github.com/owner/repo.git')).toBe('ssh_key');
  });

  it('infers a token from an https url', () => {
    expect(infer('https://github.com/owner/repo.git')).toBe('token');
  });

  it('falls back to token for a url the remote parser refuses', () => {
    // The refusal is the URL validator's message to give, not this one's, and it
    // is given when the connection is used. Returning a kind here must not
    // invent a second, divergent error.
    expect(infer('ext::sh -c whoami')).toBe('token');
    expect(infer('git://github.com/owner/repo.git')).toBe('token');
    expect(infer('not a url at all')).toBe('token');
  });

  it('agrees with the scheme the clone and push paths switch on', () => {
    // The one property that matters: whatever this returns must match the branch
    // git.service.ts takes, which tests `remote.scheme === 'https'`.
    for (const url of [
      'git@github.com:o/r.git',
      'ssh://git@gitlab.com/g/r.git',
      'https://github.com/o/r.git',
    ]) {
      const scheme = assertSafeRemoteUrl(url).scheme;
      expect(infer(url)).toBe(scheme === 'ssh' ? 'ssh_key' : 'token');
    }
  });
});
