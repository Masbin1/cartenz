import { effectiveRepositoryUrl, repositoryUrlFromConnections } from './repository-url';

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
