import { buildTestToolRegistry } from '../tools/test-registry';
import { ToolPermissionValidator } from '../tools/permission-validator';
import { DEFAULT_AGENT_PERMISSIONS } from '../../core/authz/agent-permissions';

/**
 * The tool surface of `odoo_online` (ADR-028).
 *
 * The mode's whole safety argument is that it has no filesystem and no Git: the
 * agent reaches an Odoo instance and nothing else. That is a property of which
 * tools the validator permits, so it is asserted over the registry rather than
 * per tool - a filesystem tool added later without a `modes` declaration would
 * fail here, which is the point.
 */
describe('the odoo_online execution mode', () => {
  const registry = buildTestToolRegistry();
  const validator = new ToolPermissionValidator(registry);

  const policy = (executionMode: 'odoo_online' | 'odoo_sh') => ({
    agentPermissions: { ...DEFAULT_AGENT_PERMISSIONS },
    grantedApprovals: [] as string[],
    executionMode,
  });

  const permittedIn = (mode: 'odoo_online' | 'odoo_sh') =>
    registry
      .all()
      .filter(
        (tool) =>
          validator.validate({ toolName: tool.name, input: validInputFor(tool.name) }, policy(mode))
            .outcome === 'allowed',
      )
      .map((tool) => tool.name)
      .sort();

  it('permits only the Odoo tools, and every one of them', () => {
    expect(permittedIn('odoo_online')).toEqual([
      'odoo_add_field_to_view',
      'odoo_create_field',
      'odoo_list_fields',
      'odoo_list_models',
    ]);
  });

  it('refuses every filesystem and Git tool, by name and with a reason', () => {
    for (const toolName of ['read_file', 'update_file', 'create_file', 'delete_file', 'git_commit', 'git_push']) {
      const decision = validator.validate(
        { toolName, input: validInputFor(toolName) },
        policy('odoo_online'),
      );
      expect(decision.outcome).toBe('denied');
      expect(decision.outcome === 'denied' && decision.reason).toContain('execution mode');
    }
  });

  it('does not offer the Odoo Online tools to a repository-backed task', () => {
    // The converse of the above: the mode gate cuts both ways, so an odoo_sh task
    // cannot reach a live instance through the tools meant for a different mode.
    for (const toolName of ['odoo_create_field', 'odoo_add_field_to_view']) {
      const decision = validator.validate(
        { toolName, input: validInputFor(toolName) },
        policy('odoo_sh'),
      );
      expect(decision.outcome).toBe('denied');
    }
  });

  it('refuses everything mode-gated when a task has no execution mode at all', () => {
    // An ai_project has no execution surface. Failing closed here is what stops it
    // inheriting whichever mode's tools happened to be checked first.
    const gated = registry.all().filter((tool) => tool.modes !== undefined);
    expect(gated.length).toBeGreaterThan(0);

    for (const tool of gated) {
      const decision = validator.validate(
        { toolName: tool.name, input: validInputFor(tool.name) },
        { ...policy('odoo_sh'), executionMode: null },
      );
      expect(decision.outcome).toBe('denied');
    }
  });
});

/**
 * A well-formed input per tool, so that a denial in these tests is always the
 * mode gate rather than a malformed request - the validator checks the mode
 * first, but an input that fails validation would hide a regression that moved
 * the order.
 */
function validInputFor(toolName: string): Record<string, unknown> {
  switch (toolName) {
    case 'read_file':
      return { path: 'models/sale_order.py' };
    case 'update_file':
      return { path: 'models/sale_order.py', content: 'x = 1', summary: 'add a field' };
    case 'create_file':
      return { path: 'models/new.py', content: 'x = 1', summary: 'add a file' };
    case 'delete_file':
      return { path: 'models/old.py', summary: 'remove a file' };
    case 'edit_file':
      return { path: 'models/sale_order.py', find: 'a', replace: 'b', summary: 'edit' };
    case 'search_code':
      return { query: 'sale.order' };
    case 'git_commit':
      return { message: 'a commit message' };
    case 'odoo_list_fields':
      return { model: 'sale.order' };
    case 'odoo_create_field':
      return { model: 'sale.order', name: 'po_number', label: 'PO Number', type: 'char' };
    case 'odoo_add_field_to_view':
      return { model: 'sale.order', field: 'x_po_number', after: 'payment_term_id' };
    default:
      return {};
  }
}
