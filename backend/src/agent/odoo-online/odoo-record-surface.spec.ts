import { buildTestToolRegistry } from '../tools/test-registry';
import { ToolPermissionValidator } from '../tools/permission-validator';
import { DEFAULT_AGENT_PERMISSIONS } from '../../core/authz/agent-permissions';
import { OdooOnlineClient } from './odoo-online-client';
import {
  MAX_RECORDS_PER_READ,
  MAX_RECORDS_PER_WRITE,
  effectiveReadLimit,
  recordModelRefusal,
  validateCreateRecords,
  validateSearchRecords,
  validateUpdateRecords,
} from './odoo-record-surface';

/**
 * The record surface of Odoo Online (ADR-064).
 *
 * The request this exists for is "buatkan sample data product": the agent must be
 * able to create business records on a live instance. The properties under test
 * are the ones that keep that from becoming "the agent may do anything to the
 * instance": which models are reachable, which RPC methods, how many records per
 * call, and that a write in a conversation always waits for a person.
 */
describe('the Odoo Online record surface', () => {
  describe('which models are records', () => {
    it.each(['product.template', 'product.product', 'res.partner', 'sale.order', 'crm.lead'])(
      'accepts %s as a record model',
      (model) => {
        expect(recordModelRefusal(model)).toBeNull();
      },
    );

    it.each([
      'res.users',
      'res.groups',
      'res.users.apikeys',
      'res.config.settings',
      'ir.model.access',
      'ir.rule',
      'ir.config_parameter',
      'ir.cron',
      'ir.actions.server',
      'base.automation',
      'mail.alias',
      'fetchmail.server',
      'payment.provider',
    ])('never treats %s as record data', (model) => {
      expect(recordModelRefusal(model)).toMatch(/never written or read as data/);
    });

    it('refuses a malformed model name', () => {
      expect(recordModelRefusal('product template')).toMatch(/not a valid/);
      expect(recordModelRefusal('')).toMatch(/not a valid/);
    });
  });

  describe('input validation', () => {
    it('accepts a batch of sample products', () => {
      expect(
        validateCreateRecords({
          model: 'product.template',
          records: [
            { name: 'Office Chair', list_price: 149 },
            { name: 'Standing Desk', list_price: 499 },
          ],
        }),
      ).toBeNull();
    });

    it(`caps a create at ${MAX_RECORDS_PER_WRITE} records`, () => {
      const records = Array.from({ length: MAX_RECORDS_PER_WRITE + 1 }, (_, i) => ({ name: `P${i}` }));
      expect(validateCreateRecords({ model: 'product.template', records })).toMatch(/at most/);
    });

    it('refuses an empty record or an empty batch', () => {
      expect(validateCreateRecords({ model: 'product.template', records: [] })).toMatch(/non-empty/);
      expect(validateCreateRecords({ model: 'product.template', records: [{}] })).toMatch(/non-empty/);
    });

    it('refuses a create on a protected model before anything else', () => {
      expect(
        validateCreateRecords({ model: 'res.users', records: [{ login: 'x' }] }),
      ).toMatch(/never written/);
    });

    it('requires integer ids and values for an update', () => {
      expect(
        validateUpdateRecords({ model: 'product.template', ids: [1, 2], values: { list_price: 10 } }),
      ).toBeNull();
      expect(
        validateUpdateRecords({ model: 'product.template', ids: ['1'], values: { a: 1 } }),
      ).toMatch(/positive integers/);
      expect(
        validateUpdateRecords({ model: 'product.template', ids: [1], values: {} }),
      ).toMatch(/non-empty/);
    });

    it('validates a search and caps its limit', () => {
      expect(validateSearchRecords({ model: 'res.partner', domain: [['name', 'ilike', 'a']] })).toBeNull();
      expect(validateSearchRecords({ model: 'res.partner', domain: 'x' })).toMatch(/domain/);
      expect(effectiveReadLimit(undefined)).toBe(20);
      expect(effectiveReadLimit(5000)).toBe(MAX_RECORDS_PER_READ);
    });
  });

  describe('the client', () => {
    const credentials = {
      url: 'https://mkht.odoo.com',
      db: 'mkht',
      login: 'someone@example.com',
      apiKey: 'test-key',
    };

    const capture = (result: unknown) => {
      const calls: unknown[][] = [];
      global.fetch = jest.fn(async (_endpoint: string, init: { body: string }) => {
        calls.push((JSON.parse(init.body) as { params: { args: unknown[] } }).params.args);
        return { ok: true, json: async () => ({ result }) } as unknown as Response;
      }) as unknown as typeof fetch;
      return { client: new OdooOnlineClient(), calls };
    };

    afterEach(() => jest.restoreAllMocks());

    it('creates a batch in one execute_kw call and returns every id', async () => {
      const { client, calls } = capture([41, 42]);
      const ids = await client.createRecords(credentials, 2, 'product.template', [
        { name: 'Office Chair' },
        { name: 'Standing Desk' },
      ]);

      expect(ids).toEqual([41, 42]);
      expect(calls).toHaveLength(1);
      const [, , , model, method, args] = calls[0];
      expect(model).toBe('product.template');
      expect(method).toBe('create');
      expect(args).toEqual([[{ name: 'Office Chair' }, { name: 'Standing Desk' }]]);
    });

    it('normalises a single-id create answer from an older Odoo', async () => {
      const { client } = capture(7);
      expect(await client.createRecords(credentials, 2, 'res.partner', [{ name: 'A' }])).toEqual([7]);
    });

    it('refuses a protected model at the client, before the network', async () => {
      const { client, calls } = capture(1);
      await expect(
        client.createRecords(credentials, 2, 'res.users', [{ login: 'x' }]),
      ).rejects.toThrow(/never written/);
      expect(calls).toHaveLength(0);
    });

    it('has no unlink and no execute on the record path', async () => {
      const { client, calls } = capture(true);
      const recordCall = (
        client as unknown as {
          recordCall: (...args: unknown[]) => Promise<unknown>;
        }
      ).recordCall.bind(client);

      for (const method of ['unlink', 'execute', 'action_confirm', 'sudo']) {
        await expect(
          recordCall(credentials, 2, 'product.template', method, [[1]]),
        ).rejects.toThrow(/not permitted/);
      }
      expect(calls).toHaveLength(0);
    });
  });

  describe('the permission gate', () => {
    const registry = buildTestToolRegistry();
    const validator = new ToolPermissionValidator(registry);
    const createInput = { model: 'product.template', records: [{ name: 'Office Chair' }] };

    const policy = (overrides: {
      write?: boolean;
      read?: boolean;
      granted?: string[];
      kind?: 'chat' | 'change';
    }) => ({
      agentPermissions: {
        ...DEFAULT_AGENT_PERMISSIONS,
        database_record_write: overrides.write ?? true,
        database_record_read: overrides.read ?? true,
      },
      grantedApprovals: overrides.granted ?? [],
      executionMode: 'odoo_online' as const,
      taskKind: overrides.kind ?? ('chat' as const),
    });

    it('is off by default: a new project cannot write records', () => {
      expect(DEFAULT_AGENT_PERMISSIONS.database_record_write).toBe(false);
      const decision = validator.validate(
        { toolName: 'odoo_create_records', input: createInput },
        { ...policy({}), agentPermissions: { ...DEFAULT_AGENT_PERMISSIONS } },
      );
      expect(decision.outcome).toBe('denied');
      expect(decision.outcome === 'denied' && decision.reason).toContain('database_record_write');
    });

    it('pauses a chat for approval before writing, then allows it once approved', () => {
      const before = validator.validate({ toolName: 'odoo_create_records', input: createInput }, policy({}));
      expect(before.outcome).toBe('approval_required');
      expect(before.outcome === 'approval_required' && before.approvalAction).toBe('odoo_record_write');

      const after = validator.validate(
        { toolName: 'odoo_create_records', input: createInput },
        policy({ granted: ['odoo_record_write'] }),
      );
      expect(after.outcome).toBe('allowed');
    });

    it('treats the approved plan as the approval in a change task', () => {
      const decision = validator.validate(
        { toolName: 'odoo_create_records', input: createInput },
        policy({ kind: 'change', granted: ['implementation_plan'] }),
      );
      expect(decision.outcome).toBe('allowed');
    });

    it('does not let an approved plan stand in for the gate in a chat', () => {
      const decision = validator.validate(
        { toolName: 'odoo_update_records', input: { model: 'product.template', ids: [1], values: { list_price: 1 } } },
        policy({ granted: ['implementation_plan'] }),
      );
      expect(decision.outcome).toBe('approval_required');
    });

    it('reads records without an approval when the project grants record read', () => {
      const decision = validator.validate(
        { toolName: 'odoo_search_records', input: { model: 'product.template' } },
        policy({}),
      );
      expect(decision.outcome).toBe('allowed');
    });

    it('refuses a protected model even with every permission and approval granted', () => {
      const decision = validator.validate(
        { toolName: 'odoo_create_records', input: { model: 'res.users', records: [{ login: 'x' }] } },
        policy({ granted: ['odoo_record_write'] }),
      );
      expect(decision.outcome).toBe('denied');
    });

    it('is not reachable from a repository-backed task', () => {
      const decision = validator.validate(
        { toolName: 'odoo_create_records', input: createInput },
        { ...policy({ granted: ['odoo_record_write'] }), executionMode: 'odoo_sh' as const },
      );
      expect(decision.outcome).toBe('denied');
    });
  });
});
