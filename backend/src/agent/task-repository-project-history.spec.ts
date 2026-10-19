import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRepository } from './task-repository';
import type { DatabaseService } from '../core/database/database.service';
import type { AuditService } from '../core/audit/audit.service';
import type { TaskEventPublisher } from '../core/events/task-event-publisher.service';
import type { GitCredentialsService } from '../modules/settings/git-credentials.service';

/**
 * ADR-080: the read side of project-wide memory.
 *
 * `loadProjectHistory` must return every conversation's requests for the
 * project, newest first, and never the current task. `projectHistoryForPrompt`
 * must report totals that match what it actually returned, so the prompt can say
 * what it left out rather than reading as the whole record.
 */
describe('TaskRepository.loadProjectHistory (ADR-080)', () => {
  function repo(selects: unknown[][]) {
    const queue = [...selects];
    const chain = (rows: unknown[]) => {
      const self: Record<string, unknown> = {};
      for (const method of ['from', 'leftJoin', 'where', 'orderBy']) self[method] = () => self;
      self.limit = async () => rows;
      // `countProjectHistory` awaits the builder without a limit.
      self.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
      return self;
    };
    const select = jest.fn(() => chain(queue.shift() ?? []));
    const database = { db: { select } } as unknown as DatabaseService;
    const repository = new TaskRepository(
      database,
      {} as unknown as TaskEventPublisher,
      {} as unknown as AuditService,
      {} as unknown as GitCredentialsService,
    );
    return { repository, select };
  }

  it('maps a project request with its conversation title, commit and files', async () => {
    const { repository } = repo([
      [
        {
          reference: 'task_976297',
          kind: 'change',
          status: 'failed',
          sessionId: 'session-1',
          sessionTitle: 'Delivery KPI',
          createdAt: new Date('2026-10-14T13:45:00Z'),
          prompt: 'Buat devtask trip KPI',
          answer: 'Dev task written.',
          failureReason: 'git push refused: non-fast-forward',
          plan: { summary: 'Write the trip KPI dev task' },
          modifiedFiles: [{ path: 'linkederp_dashboard_api/docs/x.md' }, { nope: true }],
          commitHash: '4e389b494ac6f2fc97af272ea4c8b4edf698ef02',
        },
      ],
    ]);

    const [entry] = await repository.loadProjectHistory('project-1', {
      excludeTaskId: 'task-current',
      limit: 40,
    });

    expect(entry).toMatchObject({
      reference: 'task_976297',
      kind: 'change',
      status: 'failed',
      sessionId: 'session-1',
      sessionTitle: 'Delivery KPI',
      createdAt: '2026-10-14T13:45:00.000Z',
      planSummary: 'Write the trip KPI dev task',
      modifiedPaths: ['linkederp_dashboard_api/docs/x.md'],
      commitHash: '4e389b494ac6f2fc97af272ea4c8b4edf698ef02',
    });
  });

  it('treats a request outside a conversation as having no title', async () => {
    const { repository } = repo([
      [
        {
          reference: 'task_1',
          kind: 'chat',
          status: 'completed',
          sessionId: null,
          sessionTitle: null,
          createdAt: new Date('2026-10-14T13:45:00Z'),
          prompt: 'hello',
          answer: 'hi',
          failureReason: null,
          plan: null,
          modifiedFiles: null,
          commitHash: null,
        },
      ],
    ]);

    const [entry] = await repository.loadProjectHistory('project-1', { limit: 40 });

    expect(entry.sessionId).toBeNull();
    expect(entry.sessionTitle).toBeNull();
    expect(entry.modifiedPaths).toEqual([]);
  });

  it('reports the project totals, excluding the current request from the listed count', async () => {
    const { repository } = repo([
      [
        {
          reference: 'task_1',
          kind: 'chat',
          status: 'completed',
          sessionId: 'session-1',
          sessionTitle: 'First',
          createdAt: new Date('2026-10-14T13:45:00Z'),
          prompt: 'hello',
          answer: 'hi',
          failureReason: null,
          plan: null,
          modifiedFiles: [],
          commitHash: null,
        },
      ],
      [{ tasks: 7, conversations: 3 }],
    ]);

    const result = await repository.projectHistoryForPrompt('project-1', 'task-current', 40);

    expect(result.tasks).toHaveLength(1);
    expect(result.totalTasks).toBe(6);
    expect(result.conversationCount).toBe(3);
  });
});

describe('project history reaches both loops (ADR-080)', () => {
  const workflow = readFileSync(join(__dirname, 'orchestration', 'agent-workflow.ts'), 'utf8');
  const chatLoop = readFileSync(join(__dirname, 'orchestration', 'model-chat-loop.ts'), 'utf8');
  const planner = readFileSync(join(__dirname, 'orchestration', 'model-agent-planner.ts'), 'utf8');

  it('gives the chat loop the project index', () => {
    const chat = workflow.slice(workflow.indexOf('private async implementChat'));
    expect(chat).toMatch(/projectHistory: await this\.projectHistory\(snapshot\)/);
  });

  it('gives both planning paths the same index', () => {
    const planCalls = workflow.split('this.planner.create').slice(1);
    expect(planCalls).toHaveLength(2);
    for (const call of planCalls) {
      const args = call.slice(0, call.indexOf('});'));
      expect(args).toMatch(/projectHistory: await this\.projectHistory\(snapshot\)/);
    }
  });

  it('renders the part in the chat prompt', () => {
    expect(chatLoop).toMatch(/for \(const part of input\.projectHistory \?\? \[\]\)/);
  });

  it('renders the part in both planner prompt shapes', () => {
    const rendered = planner.match(/\.\.\.\(input\.projectHistory \?\? \[\]\)/g) ?? [];
    expect(rendered).toHaveLength(2);
  });

  it('never fails a task because project history could not be read', () => {
    const block = workflow.slice(workflow.indexOf('private async projectHistory'));
    expect(block.slice(0, 1200)).toMatch(/catch \(error\)[\s\S]*?return \[\];/);
  });
});
