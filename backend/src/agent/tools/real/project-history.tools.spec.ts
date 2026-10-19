import { ProjectHistoryTools } from './project-history.tools';
import type { TaskRepository } from '../../task-repository';
import type { ProjectHistoryTask } from '../../orchestration/project-history';
import type { ToolDefinition, ToolExecutionContext } from '../tool.interface';

/**
 * ADR-080: `read_project_history` is how a model reads one earlier request in
 * full when the prompt index is not enough.
 *
 * The tool reads the platform's own record for the project it is already working
 * on: it leaves nothing, needs no approval, and never returns the current task.
 */
function entry(overrides: Partial<ProjectHistoryTask> = {}): ProjectHistoryTask {
  return {
    reference: 'task_976297',
    kind: 'change',
    status: 'failed',
    sessionId: 'session-1',
    sessionTitle: 'Delivery KPI',
    createdAt: '2026-10-14T13:45:00.000Z',
    prompt: 'Buat devtask trip KPI',
    answer: 'Dev task written.',
    failureReason: 'git push refused: non-fast-forward',
    planSummary: null,
    modifiedPaths: ['linkederp_dashboard_api/docs/delivery-trip-kpi-dev-task.md'],
    commitHash: '4e389b49',
    ...overrides,
  };
}

function tools(overrides: {
  load?: jest.Mock;
  counts?: { tasks: number; conversations: number };
} = {}) {
  const load =
    overrides.load ?? jest.fn(async () => [entry()]);
  const countProjectHistory = jest.fn(async () => overrides.counts ?? { tasks: 7, conversations: 3 });
  const repository = {
    loadProjectHistory: load,
    countProjectHistory,
  } as unknown as TaskRepository;

  const instance = new ProjectHistoryTools(repository);
  const definition = instance.definitions[0] as ToolDefinition;
  return { instance, definition, load, countProjectHistory };
}

const context = {
  taskId: 'task-current',
  taskReference: 'task_100000',
  projectId: 'project-1',
} as unknown as ToolExecutionContext;

describe('read_project_history definition (ADR-080)', () => {
  it('is a model-callable read that leaves nothing and needs no approval', () => {
    const { definition } = tools();

    expect(definition.name).toBe('read_project_history');
    expect(definition.permission).toBe('project_history_read');
    expect(definition.availableToModel).toBe(true);
    expect(definition.leavesPlatform).toBe(false);
    expect(definition.simulated).toBe(false);
  });

  it('accepts no arguments, a reference, a conversation, or a limit', () => {
    const { definition } = tools();

    expect(definition.validate({})).toBeNull();
    expect(definition.validate({ reference: 'task_1' })).toBeNull();
    expect(definition.validate({ sessionId: 'session-1', limit: 5 })).toBeNull();
  });

  it('refuses a malformed request before reading anything', () => {
    const { definition } = tools();

    expect(definition.validate(null)).toBe('input must be an object');
    expect(definition.validate({ reference: '' })).toBe('reference must be a non-empty string');
    expect(definition.validate({ limit: 0 })).toBe('limit must be between 1 and 20');
    expect(definition.validate({ limit: 999 })).toBe('limit must be between 1 and 20');
    expect(definition.validate({ limit: 2.5 })).toBe('limit must be an integer');
  });
});

describe('read_project_history execution (ADR-080)', () => {
  it('reads the project, excluding the task that is asking', async () => {
    const { definition, load } = tools();

    await definition.execute({}, context);

    expect(load).toHaveBeenCalledWith('project-1', { excludeTaskId: 'task-current', limit: 10 });
  });

  it('narrows to one conversation or one request when asked', async () => {
    const { definition, load } = tools();

    await definition.execute({ sessionId: 'session-1', reference: 'task_5', limit: 3 }, context);

    expect(load).toHaveBeenCalledWith('project-1', {
      excludeTaskId: 'task-current',
      limit: 3,
      sessionId: 'session-1',
      reference: 'task_5',
    });
  });

  it('returns the request in full, with how much history exists beside it', async () => {
    const { definition } = tools();

    const output = await definition.execute({}, context);

    expect(output.returned).toBe(1);
    expect(output.projectTasks).toBe(7);
    expect(output.projectConversations).toBe(3);
    expect((output.tasks as Record<string, unknown>[])[0]).toMatchObject({
      reference: 'task_976297',
      sessionTitle: 'Delivery KPI',
      failureReason: 'git push refused: non-fast-forward',
      commitHash: '4e389b49',
    });
  });

  it('shortens a long answer rather than flooding the context it protects', async () => {
    const { definition } = tools({
      load: jest.fn(async () => [entry({ answer: 'z'.repeat(9000) })]),
    });

    const output = await definition.execute({}, context);
    const first = (output.tasks as Record<string, unknown>[])[0];

    expect(String(first.answer)).toContain('[shortened, 3000 more characters]');
  });

  it('says plainly that the project has no other request, instead of returning nothing unexplained', async () => {
    const { definition } = tools({ load: jest.fn(async () => []), counts: { tasks: 1, conversations: 1 } });

    const output = await definition.execute({}, context);

    expect(output.returned).toBe(0);
    expect(String(output.note)).toContain('no history besides the current request');
  });
});
