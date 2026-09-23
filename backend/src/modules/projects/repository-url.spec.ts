import {
  applyTransportToUrl,
  effectiveRepositoryUrl,
  repositoryUrlFromConnections,
  transportOfUrl,
} from './repository-url';

describe('repositoryUrlFromConnections', () => {
  it('reads cloneUrl from a github connection', () => {
    const url = repositoryUrlFromConnections([
      { connectionType: 'github', metadata: { cloneUrl: 'https://github.com/acme/repo.git' } },
    ]);
    expect(url).toBe('https://github.com/acme/repo.git');
  });

  it('falls back to repositoryUrl, then url, when cloneUrl is absent', () => {
    expect(
      repositoryUrlFromConnections([
        { connectionType: 'gitlab', metadata: { repositoryUrl: 'https://gitlab.com/acme/repo.git' } },
      ]),
    ).toBe('https://gitlab.com/acme/repo.git');

    expect(
      repositoryUrlFromConnections([
        { connectionType: 'odoo_sh', metadata: { url: 'ssh://git@odoo.sh/acme/repo' } },
      ]),
    ).toBe('ssh://git@odoo.sh/acme/repo');
  });

  it('ignores an odoo_api connection: it is a credential, not a git remote', () => {
    const url = repositoryUrlFromConnections([
      { connectionType: 'odoo_api', metadata: { url: 'https://acme.odoo.com' } },
    ]);
    expect(url).toBeNull();
  });

  it('returns null when no connection carries a usable url', () => {
    expect(repositoryUrlFromConnections([{ connectionType: 'github', metadata: {} }])).toBeNull();
    expect(repositoryUrlFromConnections([{ connectionType: 'github', metadata: null }])).toBeNull();
    expect(repositoryUrlFromConnections([])).toBeNull();
  });

  it('skips a connection with no usable url and takes the next one', () => {
    const url = repositoryUrlFromConnections([
      { connectionType: 'odoo_api', metadata: { url: 'https://acme.odoo.com' } },
      { connectionType: 'github', metadata: { cloneUrl: 'https://github.com/acme/repo.git' } },
    ]);
    expect(url).toBe('https://github.com/acme/repo.git');
  });

  it('ignores a blank string the same as a missing key', () => {
    const url = repositoryUrlFromConnections([
      { connectionType: 'github', metadata: { cloneUrl: '   ', url: 'https://github.com/acme/repo' } },
    ]);
    expect(url).toBe('https://github.com/acme/repo');
  });
});

describe('effectiveRepositoryUrl', () => {
  it('prefers the project column when it is set', () => {
    const url = effectiveRepositoryUrl('https://example.com/typed.git', [
      { connectionType: 'github', metadata: { cloneUrl: 'https://github.com/acme/repo.git' } },
    ]);
    expect(url).toBe('https://example.com/typed.git');
  });

  it('falls back to a connection when the column is null', () => {
    const url = effectiveRepositoryUrl(null, [
      { connectionType: 'github', metadata: { cloneUrl: 'https://github.com/acme/repo.git' } },
    ]);
    expect(url).toBe('https://github.com/acme/repo.git');
  });

  it('falls back to a connection when the column is an empty string', () => {
    const url = effectiveRepositoryUrl('   ', [
      { connectionType: 'github', metadata: { cloneUrl: 'https://github.com/acme/repo.git' } },
    ]);
    expect(url).toBe('https://github.com/acme/repo.git');
  });

  it('returns null when neither the column nor a connection has one', () => {
    expect(effectiveRepositoryUrl(null, [])).toBeNull();
    expect(effectiveRepositoryUrl(undefined, [{ connectionType: 'odoo_api', metadata: {} }])).toBeNull();
  });
});

describe('transportOfUrl', () => {
  it('reads https from an https URL', () => {
    expect(transportOfUrl('https://github.com/acme/repo.git')).toBe('https');
  });

  it('reads ssh from both ssh URL forms', () => {
    expect(transportOfUrl('ssh://git@github.com/acme/repo.git')).toBe('ssh');
    expect(transportOfUrl('git@github.com:acme/repo.git')).toBe('ssh');
  });

  it('returns null for an unparseable URL', () => {
    expect(transportOfUrl('not a url')).toBeNull();
  });
});

describe('applyTransportToUrl (ADR-059)', () => {
  it('leaves the URL untouched under auto', () => {
    expect(applyTransportToUrl('https://github.com/acme/repo.git', 'auto')).toBe(
      'https://github.com/acme/repo.git',
    );
    expect(applyTransportToUrl('git@github.com:acme/repo.git', 'auto')).toBe(
      'git@github.com:acme/repo.git',
    );
  });

  it('rewrites an ssh URL to https', () => {
    expect(applyTransportToUrl('git@github.com:acme/repo.git', 'https')).toBe(
      'https://github.com/acme/repo.git',
    );
    expect(applyTransportToUrl('ssh://git@github.com/acme/repo.git', 'https')).toBe(
      'https://github.com/acme/repo.git',
    );
  });

  it('rewrites an https URL to ssh, defaulting the account to git', () => {
    expect(applyTransportToUrl('https://github.com/acme/repo.git', 'ssh')).toBe(
      'ssh://git@github.com/acme/repo.git',
    );
  });

  it('rewriting to ssh keeps a non-default account from the original URL', () => {
    expect(applyTransportToUrl('ssh://deploy@github.com/acme/repo.git', 'https')).toBe(
      'https://github.com/acme/repo.git',
    );
  });

  it('is idempotent: a URL already in the requested form is returned unchanged', () => {
    expect(applyTransportToUrl('https://github.com/acme/repo.git', 'https')).toBe(
      'https://github.com/acme/repo.git',
    );
    expect(applyTransportToUrl('git@github.com:acme/repo.git', 'ssh')).toBe(
      'git@github.com:acme/repo.git',
    );
  });

  it('leaves an unparseable URL exactly as written, for either transport', () => {
    expect(applyTransportToUrl('not a url', 'https')).toBe('not a url');
    expect(applyTransportToUrl('not a url', 'ssh')).toBe('not a url');
  });

  it('leaves a URL with a non-default port untouched rather than mangling the port', () => {
    expect(applyTransportToUrl('https://example.test:8443/acme/repo.git', 'ssh')).toBe(
      'https://example.test:8443/acme/repo.git',
    );
  });
});
