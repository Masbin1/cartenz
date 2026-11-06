import { ModelImplementationLoop, VERIFY_EXCLUDED_TOOLS } from './model-implementation-loop';
import type { ToolRegistry } from '../tools/tool-registry';
import type { ModelProviderResolver } from '../model/model-provider-resolver';
import type { AppConfig } from '../../core/config/configuration';
import type { AnyToolDefinition } from '../tools/tool.interface';

/**
 * ADR-094: in `'verify'` mode, the schema-write tools are withheld so a
 * verification pass cannot silently become a second implementation pass.
 * `offeredTools` is private; reached here the same way the class itself
 * calls it, through a minimal fake registry, rather than duplicating its
 * filter logic in the test.
 */
describe('ModelImplementationLoop.offeredTools — verify mode (ADR-094)', () => {
  function fakeTool(name: string, permission: string): AnyToolDefinition {
    return {
      name,
      description: name,
      permission,
      modes: ['odoo_online'],
      leavesPlatform: false,
      simulated: false,
      availableToModel: true,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      validate: () => null,
      execute: async () => ({}),
    } as unknown as AnyToolDefinition;
  }

  function loopWith(tools: AnyToolDefinition[]): ModelImplementationLoop {
    const registry = { all: () => tools } as unknown as ToolRegistry;
    return new ModelImplementationLoop(
      {} as unknown as ModelProviderResolver,
      registry,
      {} as unknown as AppConfig,
    );
  }

  const allTools = [
    fakeTool('odoo_create_field', 'odoo_customize'),
    fakeTool('odoo_create_model', 'odoo_customize'),
    fakeTool('odoo_add_field_to_view', 'odoo_customize'),
    fakeTool('odoo_create_records', 'database_record_write'),
    fakeTool('odoo_search_records', 'database_record_read'),
    fakeTool('browser_click', 'browser_control'),
  ];

  const allGranted = {
    odoo_customize: true,
    database_record_write: true,
    database_record_read: true,
    browser_control: true,
  };

  function offered(loop: ModelImplementationLoop, mode?: 'implement' | 'verify') {
    return (
      loop as unknown as {
        offeredTools: (
          permissions: Record<string, boolean>,
          executionMode: string | null,
          mode?: 'implement' | 'verify',
        ) => { name: string }[];
      }
    ).offeredTools(allGranted, 'odoo_online', mode).map((tool) => tool.name);
  }

  it('offers every granted tool in implement mode (the default)', () => {
    const names = offered(loopWith(allTools));
    for (const excluded of VERIFY_EXCLUDED_TOOLS) expect(names).toContain(excluded);
    expect(names).toContain('odoo_create_records');
    expect(names).toContain('browser_click');
  });

  it('withholds the schema-write tools in verify mode', () => {
    const names = offered(loopWith(allTools), 'verify');
    for (const excluded of VERIFY_EXCLUDED_TOOLS) expect(names).not.toContain(excluded);
  });

  it('still offers the record and browser tools in verify mode', () => {
    const names = offered(loopWith(allTools), 'verify');
    expect(names).toContain('odoo_create_records');
    expect(names).toContain('odoo_search_records');
    expect(names).toContain('browser_click');
  });

  it('still respects agent permissions in verify mode - a tool not granted is still absent', () => {
    const names = offered(
      loopWith(allTools.filter((tool) => tool.name !== 'browser_click')),
      'verify',
    );
    expect(names).not.toContain('browser_click');
  });
});
