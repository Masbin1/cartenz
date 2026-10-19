import { GitHubRepositoryService } from './github-repository.service';
import type { AppConfig } from '../../core/config/configuration';

/**
 * Deleting a project deletes the GitHub repository it created (ADR-076).
 *
 * The dangerous direction is over-deletion: a project may hold a connection to a
 * repository the operator brought — an Odoo.sh repository, a customer's own
 * account — and that repository must survive its project here. These tests pin
 * that boundary, the retry-safe 404, and the refusal that keeps the project
 * deletable when GitHub says no.
 */
describe('GitHubRepositoryService.removeForProject', () => {
  const config = (overrides: Partial<AppConfig['github']> = {}) =>
    ({
      git: { pushEnabled: true },
      github: {
        token: 'ghp_test_token',
        owner: 'BintangLinked',
        repositoryEnabled: true,
        visibility: 'private',
        ...overrides,
      },
    }) as unknown as AppConfig;

  const withConnections = (metadata: Array<Record<string, unknown>>) =>
    ({
      db: {
        select: () => ({
          from: () => ({
            where: async () => metadata.map((entry) => ({ metadata: entry })),
          }),
        }),
      },
    }) as never;

  const serviceFor = (metadata: Array<Record<string, unknown>>, cfg = config()) => {
    const github = { deleteRepository: jest.fn() };
    const service = new GitHubRepositoryService(
      cfg,
      github as never,
      {} as never,
      withConnections(metadata),
      {} as never,
    );
    return { service, github };
  };

  it('skips a project that records no repository at all', async () => {
    const { service, github } = serviceFor([{}]);

    const result = await service.removeForProject('project-1');

    expect(result.status).toBe('skipped');
    expect(result.message).toMatch(/No GitHub repository is recorded/);
    expect(github.deleteRepository).not.toHaveBeenCalled();
  });

  it('leaves a repository this platform did not create alone', async () => {
    // A connected Odoo.sh repository: under the same owner, but created there.
    const { service, github } = serviceFor([
      { repository: 'BintangLinked/their-odoo', managedBy: 'odoo-sh' },
    ]);

    const result = await service.removeForProject('project-1');

    expect(result.status).toBe('skipped');
    expect(result.repository).toBe('BintangLinked/their-odoo');
    expect(result.message).toMatch(/not one this platform created/);
    expect(github.deleteRepository).not.toHaveBeenCalled();
  });

  it('leaves a legacy Odoo.sh connection alone, which is recognised by its remote URL', async () => {
    const { service, github } = serviceFor([
      {
        repository: 'BintangLinked/their-odoo',
        repositoryUrl: 'https://github.com/BintangLinked/their-odoo.git',
      },
    ]);

    const result = await service.removeForProject('project-1');

    expect(result.status).toBe('skipped');
    expect(github.deleteRepository).not.toHaveBeenCalled();
  });

  it('deletes the repository recorded under the configured owner', async () => {
    const { service, github } = serviceFor([
      { repository: 'BintangLinked/toko-roti-budi', managedBy: 'cartenz' },
    ]);
    github.deleteRepository.mockResolvedValueOnce(true);

    const result = await service.removeForProject('project-1');

    expect(github.deleteRepository).toHaveBeenCalledWith('BintangLinked', 'toko-roti-budi');
    expect(result.status).toBe('deleted');
    expect(result.repository).toBe('BintangLinked/toko-roti-budi');
  });

  it('deletes a legacy platform connection, which predates the marker', async () => {
    const { service, github } = serviceFor([{ repository: 'BintangLinked/omaga' }]);
    github.deleteRepository.mockResolvedValueOnce(true);

    const result = await service.removeForProject('project-1');

    expect(result.status).toBe('deleted');
    expect(github.deleteRepository).toHaveBeenCalledWith('BintangLinked', 'omaga');
  });

  it('leaves a repository under another owner alone, even when this platform recorded it', async () => {
    const { service, github } = serviceFor([
      { repository: 'customer/their-odoo', managedBy: 'cartenz' },
    ]);

    const result = await service.removeForProject('project-1');

    expect(result.status).toBe('skipped');
    expect(github.deleteRepository).not.toHaveBeenCalled();
  });

  it('matches the owner case-insensitively, as GitHub does', async () => {
    const { service, github } = serviceFor([{ repository: 'bintanglinked/omaga' }]);
    github.deleteRepository.mockResolvedValueOnce(true);

    await service.removeForProject('project-1');

    expect(github.deleteRepository).toHaveBeenCalledWith('bintanglinked', 'omaga');
  });

  it('treats an already-absent repository as absent, not a failure', async () => {
    const { service, github } = serviceFor([{ repository: 'BintangLinked/gone' }]);
    github.deleteRepository.mockResolvedValueOnce(false);

    const result = await service.removeForProject('project-1');

    expect(result.status).toBe('absent');
    expect(result.message).toMatch(/already absent/);
  });

  it('keeps the repository when the caller asked to, even without a token', async () => {
    const { service, github } = serviceFor(
      [{ repository: 'BintangLinked/omaga' }],
      config({ token: null }),
    );

    const result = await service.removeForProject('project-1', { keep: true });

    expect(result.status).toBe('skipped');
    expect(result.repository).toBe('BintangLinked/omaga');
    expect(result.message).toMatch(/Kept GitHub repository/);
    expect(github.deleteRepository).not.toHaveBeenCalled();
  });

  it('refuses when no token can delete the repository', async () => {
    const { service, github } = serviceFor(
      [{ repository: 'BintangLinked/omaga' }],
      config({ token: null }),
    );

    const result = await service.removeForProject('project-1');

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/GITHUB_TOKEN is not configured/);
    expect(github.deleteRepository).not.toHaveBeenCalled();
  });

  it('reports GitHub’s own refusal instead of claiming the repository is gone', async () => {
    const { service, github } = serviceFor([{ repository: 'BintangLinked/omaga' }]);
    github.deleteRepository.mockRejectedValueOnce(
      new Error('Calling DELETE /repos/BintangLinked/omaga failed (403): Resource not accessible'),
    );

    const result = await service.removeForProject('project-1');

    expect(result.status).toBe('failed');
    expect(result.repository).toBe('BintangLinked/omaga');
    expect(result.message).toMatch(/could not be deleted/);
    expect(result.message).toMatch(/Resource not accessible/);
  });
});
