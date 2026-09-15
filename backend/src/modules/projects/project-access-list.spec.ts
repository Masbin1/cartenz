import { redactLockedProject } from './projects.service';

/**
 * What a locked project shows in the list (ADR-043).
 *
 * The point of the redaction is that "locked" is a boundary and not a colour in
 * the UI. If the repository URL and the task counts are sent anyway, the data is
 * already in the browser and the padlock is decoration.
 */
describe('a locked project in the list', () => {
  const row = {
    id: 'p1',
    name: 'Finance rollout',
    description: 'Client X migration',
    projectType: 'odoo_sh' as const,
    odooVersion: '17.0',
    defaultBranch: 'main',
    repositoryUrl: 'git@github.com:client/private.git',
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    taskCount: 12,
    openTaskCount: 3,
  };

  it('withholds the repository URL, description and task counts', () => {
    const locked = redactLockedProject(row, false);

    expect(locked.repositoryUrl).toBeNull();
    expect(locked.description).toBeNull();
    expect(locked.taskCount).toBeNull();
    expect(locked.openTaskCount).toBeNull();
  });

  it('keeps enough to render the row', () => {
    const locked = redactLockedProject(row, false);

    expect(locked.name).toBe('Finance rollout');
    expect(locked.projectType).toBe('odoo_sh');
    expect(locked.odooVersion).toBe('17.0');
    expect(locked.hasAccess).toBe(false);
  });

  it('changes nothing for a project the caller may open', () => {
    const open = redactLockedProject(row, true);

    expect(open.repositoryUrl).toBe('git@github.com:client/private.git');
    expect(open.taskCount).toBe(12);
    expect(open.hasAccess).toBe(true);
  });
});
