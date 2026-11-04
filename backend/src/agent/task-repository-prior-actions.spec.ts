import { TaskRepository } from './task-repository';
import type { DatabaseService } from '../core/database/database.service';
import type { AuditService } from '../core/audit/audit.service';
import type { TaskEventPublisher } from '../core/events/task-event-publisher.service';
import type { GitCredentialsService } from '../modules/settings/git-credentials.service';

/**
 * ADR-092: `loadPriorActions` is what lets a task resumed after an approval
 * know what it already did, instead of re-entering implementation with no
 * memory of the steps taken before it suspended.
 */
describe('TaskRepository.loadPriorActions (ADR-092)', () => {
  function repo(rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where']) chain[method] = () => chain;
    chain.orderBy = async () => rows;
    const select = jest.fn(() => chain);
    const database = { db: { select } } as unknown as DatabaseService;
    const repository = new TaskRepository(
      database,
      {} as unknown as TaskEventPublisher,
      {} as unknown as AuditService,
      {} as unknown as GitCredentialsService,
    );
    return { repository, select };
  }

  it('maps a successful action to a PriorAction', async () => {
    const { repository } = repo([
      {
        toolName: 'odoo_create_field',
        input: { model: 'res.partner', name: 'x_max_discount' },
        output: { field: 'x_max_discount', model: 'res.partner', fieldId: 19299 },
      },
    ]);

    const actions = await repository.loadPriorActions('task-1', 60);

    expect(actions).toEqual([
      {
        toolName: 'odoo_create_field',
        input: { model: 'res.partner', name: 'x_max_discount' },
        output: { field: 'x_max_discount', model: 'res.partner', fieldId: 19299 },
      },
    ]);
  });

  it('filters out rows with no tool name (reasoning/transition steps)', async () => {
    const { repository } = repo([
      { toolName: null, input: null, output: null },
      { toolName: 'odoo_list_fields', input: { model: 'sale.order' }, output: { count: 3 } },
    ]);

    const actions = await repository.loadPriorActions('task-1', 60);

    expect(actions).toEqual([
      { toolName: 'odoo_list_fields', input: { model: 'sale.order' }, output: { count: 3 } },
    ]);
  });

  it('defaults a null input/output to an empty object', async () => {
    const { repository } = repo([{ toolName: 'read_project_history', input: null, output: null }]);

    const actions = await repository.loadPriorActions('task-1', 60);

    expect(actions).toEqual([{ toolName: 'read_project_history', input: {}, output: {} }]);
  });

  it('caps the result at maxActions', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      toolName: `tool_${i}`,
      input: {},
      output: {},
    }));
    const { repository } = repo(rows);

    const actions = await repository.loadPriorActions('task-1', 2);

    expect(actions).toHaveLength(2);
    expect(actions[0].toolName).toBe('tool_0');
    expect(actions[1].toolName).toBe('tool_1');
  });

  it('returns an empty array when the task has made no actions', async () => {
    const { repository } = repo([]);

    expect(await repository.loadPriorActions('task-1', 60)).toEqual([]);
  });
});
