import {
  AGENT_PERMISSIONS,
  APPROVAL_BEARING_PERMISSIONS,
  DEFAULT_AGENT_PERMISSIONS,
  isAgentPermission,
  isNeverGrantable,
  resolveAgentPermissions,
} from './agent-permissions';

/**
 * These tests defend the data-blind default posture of chapter 12. A change that
 * grants database record access by default fails here.
 */
describe('agent permissions', () => {
  it('grants repository access and metadata read by default', () => {
    expect(DEFAULT_AGENT_PERMISSIONS.repository_read).toBe(true);
    expect(DEFAULT_AGENT_PERMISSIONS.repository_write).toBe(true);
    expect(DEFAULT_AGENT_PERMISSIONS.git_commit).toBe(true);
    expect(DEFAULT_AGENT_PERMISSIONS.run_tests).toBe(true);
    expect(DEFAULT_AGENT_PERMISSIONS.database_metadata_read).toBe(true);
  });

  it('denies database record access and production actions by default', () => {
    expect(DEFAULT_AGENT_PERMISSIONS.database_record_read).toBe(false);
    expect(DEFAULT_AGENT_PERMISSIONS.database_record_write).toBe(false);
    expect(DEFAULT_AGENT_PERMISSIONS.restart_odoo).toBe(false);
    expect(DEFAULT_AGENT_PERMISSIONS.production_deploy).toBe(false);
  });

  it('declares a default for every permission', () => {
    for (const permission of AGENT_PERMISSIONS) {
      expect(typeof DEFAULT_AGENT_PERMISSIONS[permission]).toBe('boolean');
    }
  });

  it('does not make export or backup grantable at all', () => {
    expect(isNeverGrantable('database_export')).toBe(true);
    expect(isNeverGrantable('database_backup')).toBe(true);
    expect(isAgentPermission('database_export')).toBe(false);
    expect(isAgentPermission('database_backup')).toBe(false);
  });

  it('requires approval for every permission that reaches outside the platform', () => {
    for (const permission of ['git_push', 'production_deploy', 'restart_odoo', 'database_record_write'] as const) {
      expect(APPROVAL_BEARING_PERMISSIONS).toContain(permission);
    }
  });

  describe('resolveAgentPermissions', () => {
    it('returns the defaults when nothing is stored', () => {
      expect(resolveAgentPermissions(null)).toEqual(DEFAULT_AGENT_PERMISSIONS);
      expect(resolveAgentPermissions(undefined)).toEqual(DEFAULT_AGENT_PERMISSIONS);
      expect(resolveAgentPermissions({})).toEqual(DEFAULT_AGENT_PERMISSIONS);
    });

    it('applies stored values over the defaults', () => {
      const resolved = resolveAgentPermissions({ git_push: false, database_record_read: true });
      expect(resolved.git_push).toBe(false);
      expect(resolved.database_record_read).toBe(true);
      expect(resolved.repository_read).toBe(true);
    });

    it('discards an unrecognised key rather than honouring it', () => {
      const resolved = resolveAgentPermissions({ database_export: true, nonsense: true } as never);
      expect(resolved).not.toHaveProperty('database_export');
      expect(resolved).not.toHaveProperty('nonsense');
    });

    it('discards a non-boolean value', () => {
      const resolved = resolveAgentPermissions({ git_push: 'yes' } as never);
      expect(resolved.git_push).toBe(DEFAULT_AGENT_PERMISSIONS.git_push);
    });

    it('does not mutate the defaults', () => {
      resolveAgentPermissions({ repository_read: false });
      expect(DEFAULT_AGENT_PERMISSIONS.repository_read).toBe(true);
    });
  });
});
