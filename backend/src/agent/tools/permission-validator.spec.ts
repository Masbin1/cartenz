import { ToolPermissionValidator, approvalActionForTool } from './permission-validator';
import { buildTestToolRegistry } from './test-registry';
import {
  DEFAULT_AGENT_PERMISSIONS,
  type AgentPermission,
} from '../../core/authz/agent-permissions';

/**
 * The permission validator is the gate every tool request passes through. These
 * tests assert that it fails closed: a capability that is not granted, not
 * registered, not well formed, or not approved does not reach execution.
 */
describe('ToolPermissionValidator', () => {
  const registry = buildTestToolRegistry();
  const validator = new ToolPermissionValidator(registry);

  const permissions = (
    overrides: Partial<Record<AgentPermission, boolean>> = {},
  ): Record<AgentPermission, boolean> => ({ ...DEFAULT_AGENT_PERMISSIONS, ...overrides });

  const policy = (
    overrides: Partial<Record<AgentPermission, boolean>> = {},
    grantedApprovals: string[] = [],
  ) => ({ agentPermissions: permissions(overrides), grantedApprovals });

  it('allows a read tool under the default permissions', () => {
    const decision = validator.validate(
      { toolName: 'read_file', input: { path: 'models/sale_order.py' } },
      policy(),
    );
    expect(decision.outcome).toBe('allowed');
  });

  it('refuses an unregistered tool', () => {
    const decision = validator.validate({ toolName: 'rm_rf', input: {} }, policy());
    expect(decision.outcome).toBe('denied');
    expect(decision.outcome === 'denied' && decision.reason).toContain('not a registered tool');
  });

  it('refuses a capability that can never be granted, even if requested', () => {
    const decision = validator.validate({ toolName: 'database_export', input: {} }, policy());
    expect(decision.outcome).toBe('denied');
    expect(decision.outcome === 'denied' && decision.reason).toContain('never permitted');
  });

  it('refuses a tool whose permission the project has not granted', () => {
    const decision = validator.validate(
      { toolName: 'update_file', input: { path: 'models/x.py', summary: 'add field' } },
      policy({ repository_write: false }),
    );
    expect(decision.outcome).toBe('denied');
    expect(decision.outcome === 'denied' && decision.reason).toContain('repository_write');
  });

  it('refuses a malformed request before any execution', () => {
    const decision = validator.validate({ toolName: 'read_file', input: {} }, policy());
    expect(decision.outcome).toBe('denied');
    expect(decision.outcome === 'denied' && decision.reason).toContain('path is required');
  });

  it('refuses a path that escapes the workspace', () => {
    for (const path of ['../../etc/passwd', '/etc/passwd', 'C:/Windows/System32']) {
      const decision = validator.validate({ toolName: 'read_file', input: { path } }, policy());
      expect(decision.outcome).toBe('denied');
    }
  });

  it('requires approval for a push even when git_push is granted', () => {
    const decision = validator.validate({ toolName: 'git_push', input: {} }, policy());
    expect(decision.outcome).toBe('approval_required');
    expect(decision.outcome === 'approval_required' && decision.approvalAction).toBe('git_push');
  });

  it('allows the push once the approval has been granted', () => {
    const decision = validator.validate({ toolName: 'git_push', input: {} }, policy({}, ['git_push']));
    expect(decision.outcome).toBe('allowed');
  });

  it('checks the permission before the approval', () => {
    // A granted approval must not compensate for a permission that is not held.
    const decision = validator.validate(
      { toolName: 'git_push', input: {} },
      policy({ git_push: false }, ['git_push']),
    );
    expect(decision.outcome).toBe('denied');
  });

  it('requires approval for a file deletion', () => {
    const decision = validator.validate(
      { toolName: 'delete_file', input: { path: 'models/obsolete.py' } },
      policy(),
    );
    expect(decision.outcome).toBe('approval_required');
    expect(decision.outcome === 'approval_required' && decision.approvalAction).toBe(
      'file_deletion',
    );
  });

  it('refuses a branch name that could be read as a command option', () => {
    for (const name of ['--upload-pack=evil', '-x', 'branch;rm -rf /', 'branch name']) {
      const decision = validator.validate({ toolName: 'git_branch', input: { name } }, policy());
      expect(decision.outcome).toBe('denied');
    }
  });
});

describe('tool registry', () => {
  const registry = buildTestToolRegistry();

  it('declares a permission for every registered tool', () => {
    for (const tool of registry.all()) {
      expect(tool.permission).toBeTruthy();
    }
  });

  it('maps an approval action for every tool that leaves the platform', () => {
    // A tool that leaves the platform without a mapped approval action would be
    // denied outright, which is safe but is a registration error.
    for (const tool of registry.all()) {
      if (tool.leavesPlatform) {
        expect(approvalActionForTool(tool.name)).not.toBeNull();
      }
    }
  });

  it('registers no shell tool', () => {
    // Unrestricted shell execution is the capability the security model exists
    // to prevent. If one is ever added, this test must be revisited deliberately.
    const names = registry.all().map((tool) => tool.name);
    for (const forbidden of ['run_shell', 'exec', 'run_command', 'run_odoo_shell']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('keeps simulated exactly the capabilities ADR-019 says are simulated', () => {
    const simulated = registry
      .all()
      .filter((tool) => tool.simulated)
      .map((tool) => tool.name)
      .sort();

    // Validation executes repository code; push leaves the platform. Asserted as
    // an exact set, so making a real capability fabricated - or a fabricated one
    // real - fails here rather than passing quietly.
    expect(simulated).toEqual(['git_push', 'run_linter', 'run_odoo_test', 'run_python_test']);
  });

  it('implements the repository, Git and metadata tools for real', () => {
    const real = registry
      .all()
      .filter((tool) => !tool.simulated)
      .map((tool) => tool.name)
      .sort();

    expect(real).toEqual([
      'create_file',
      'delete_file',
      'detect_odoo_version',
      'edit_file',
      'git_branch',
      'git_commit',
      'git_diff',
      'git_status',
      'list_directory',
      'list_modules',
      'read_file',
      'search_code',
      'update_file',
    ]);
  });

  it('reports the simulated capability categories for the task record', () => {
    const categories = registry.simulatedCapabilities();
    expect(categories).toContain('push');
    expect(categories).toContain('validation');
  });
});
