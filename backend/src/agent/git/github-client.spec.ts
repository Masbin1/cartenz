import { GitHubClient, GitHubApiError } from './github-client';
import type { AppConfig } from '../../core/config/configuration';

/**
 * GitHub repository creation (ADR-041).
 *
 * A project the platform creates lives only on this host, so the repository it is
 * pushed to has to be made for it. Two properties are worth testing rather than
 * assuming, because both are invisible in a green end-to-end run until the day they
 * matter:
 *
 *  1. **The token never appears in a URL.** It travels in an `Authorization` header.
 *     A token in a URL ends up in git's own config, in an error message, and in the
 *     repository's remote — which is exactly what `assertSafeRemoteUrl` refuses.
 *  2. **Re-running adopts rather than conflicts.** A project creation retried after a
 *     failure must not fail on the repository the first attempt already made.
 *
 * The fetch calls are fabricated here; what is asserted is the request this platform
 * makes and the repository it takes back, not GitHub's behaviour.
 */
describe('GitHubClient', () => {
  const config = (overrides: Partial<AppConfig['github']> = {}, pushEnabled = true) =>
    ({
      git: { pushEnabled },
      github: {
        token: 'ghp_test_token',
        owner: 'linkederp',
        repositoryEnabled: true,
        visibility: 'private',
        ...overrides,
      },
    }) as unknown as AppConfig;

  const json = (body: unknown, status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    }) as Response;

  const repositoryPayload = (fullName: string) => ({
    name: fullName.split('/')[1],
    full_name: fullName,
    clone_url: `https://github.com/${fullName}.git`,
    html_url: `https://github.com/${fullName}`,
    default_branch: 'main',
  });

  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const calls = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url: url as string,
      init: init as RequestInit,
      body: init?.body ? JSON.parse(init.body as string) : null,
    }));

  it('adopts a repository that already exists instead of creating a second one', async () => {
    fetchMock.mockResolvedValueOnce(json(repositoryPayload('linkederp/guitartuna')));

    const repository = await new GitHubClient(config()).ensureRepository({
      name: 'guitartuna',
      description: 'GuitarTuna',
    });

    expect(repository.fullName).toBe('linkederp/guitartuna');
    expect(repository.created).toBe(false);
    // One call: the adopt path must not also try to create.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls()[0].url).toBe('https://api.github.com/repos/linkederp/guitartuna');
  });

  it('creates under an organisation when the owner is one', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ type: 'Organization' }))
      .mockResolvedValueOnce(json(repositoryPayload('linkederp/omaga'), 201));

    const repository = await new GitHubClient(config()).ensureRepository({
      name: 'omaga',
      description: null,
    });

    expect(repository.created).toBe(true);
    const post = calls()[2];
    expect(post.url).toBe('https://api.github.com/orgs/linkederp/repos');
    expect(post.body).toEqual({ name: 'omaga', private: true, auto_init: false });
  });

  it('sends the token as a header and never in the request URL', async () => {
    fetchMock.mockResolvedValueOnce(json(repositoryPayload('linkederp/vania')));

    await new GitHubClient(config()).ensureRepository({ name: 'vania', description: null });

    const { url, init } = calls()[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_test_token');
    expect(url).not.toContain('ghp_test_token');
  });

  it('creates a public repository only when the deployment asked for one', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ type: 'Organization' }))
      .mockResolvedValueOnce(json(repositoryPayload('linkederp/open'), 201));

    await new GitHubClient(config({ visibility: 'public' })).ensureRepository({
      name: 'open',
      description: null,
    });

    expect(calls()[2].body).toMatchObject({ private: false });
  });

  it('refuses a repository created under the wrong owner rather than reporting success', async () => {
    // GITHUB_OWNER a user account that is not the token's own: `/user/repos` creates
    // under the token's account, so the result would be filed in the wrong place.
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ type: 'User' }))
      .mockResolvedValueOnce(json(repositoryPayload('someone-else/guitartuna'), 201));

    await expect(
      new GitHubClient(config()).ensureRepository({ name: 'guitartuna', description: null }),
    ).rejects.toThrow(/created under "someone-else"/);
  });

  it('surfaces what GitHub said about a rejected token', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ message: 'Resource not accessible by personal access token' }, 403),
    );

    await expect(
      new GitHubClient(config()).ensureRepository({ name: 'guitartuna', description: null }),
    ).rejects.toThrow(/Resource not accessible by personal access token/);
  });

  it('refuses a name GitHub would not accept, without calling the API', async () => {
    await expect(
      new GitHubClient(config()).ensureRepository({ name: '-not-a-repo', description: null }),
    ).rejects.toBeInstanceOf(GitHubApiError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is unavailable until a token, an owner and the switch are all present', () => {
    expect(new GitHubClient(config()).available).toBe(true);
    expect(new GitHubClient(config({ token: null })).available).toBe(false);
    expect(new GitHubClient(config({ owner: null })).available).toBe(false);
    expect(new GitHubClient(config({ repositoryEnabled: false })).available).toBe(false);
  });
});
