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
    const whereCalls: unknown[] = [];
    const chain = (rows: unknown[]) => {
      const self: Record<string, unknown> = {};
      for (const method of ['from', 'leftJoin', 'orderBy']) self[method] = () => self;
      self.where = (arg: unknown) => {
        whereCalls.push(arg);
        return self;
      };
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
    return { repository, select, whereCalls };
  }

  /**
   * drizzle's `and()`/`or()`/`ne()`/`isNull()` build a SQL AST, not a string -
   * printing one with String() or JSON.stringify() does not show the column
   * it names (and the latter throws on the AST's circular table reference).
   * This walks `queryChunks` recursively (the same shape the project's other
   * SQL-assertion tests already rely on, e.g. task-repository-answer.spec.ts)
   * and collects every column name a `sql.raw`/identifier chunk carries.
   */
  function columnNamesIn(value: unknown, seen = new Set<unknown>()): string[] {
    if (value === null || typeof value !== 'object') return [];
    if (seen.has(value)) return [];
    seen.add(value);

    const names: string[] = [];
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string') names.push(name);

    const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) names.push(...columnNamesIn(chunk, seen));
    }
    return names;
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

  /**
   * Found live: a project with every task in one session (Omnisurge, 21 tasks,
   * 1 session) sent that session's turns twice - once in full by
   * conversationContext (ADR-074), once summarised by this index (ADR-080) -
   * because this index excluded only the CURRENT task, not its conversation.
   * A duplicate costs tokens without adding context, which is the opposite of
   * what this index exists for.
   */
  it('excludes every task of the current session, not just the current task, when asked to', async () => {
    const { repository, whereCalls } = repo([[]]);

    await repository.loadProjectHistory('project-1', {
      excludeTaskId: 'task-current',
      excludeSessionId: 'session-1',
      limit: 40,
    });

    // The query builder chain is opaque to a plain mock, so the where() call's
    // actual columns are asserted on rather than trusted by construction - a
    // filter that silently no-ops would otherwise still pass every other
    // assertion.
    expect(columnNamesIn(whereCalls[0])).toContain('session_id');
  });

  it('omits the session-exclusion clause when the caller has no session to exclude', async () => {
    const { repository, whereCalls } = repo([[]]);

    await repository.loadProjectHistory('project-1', { excludeTaskId: 'task-current', limit: 40 });

    expect(columnNamesIn(whereCalls[0])).not.toContain('session_id');
  });

  it('threads excludeSessionId through projectHistoryForPrompt into the query', async () => {
    const { repository, whereCalls } = repo([[], [{ tasks: 1, conversations: 1 }]]);

    await repository.projectHistoryForPrompt('project-1', 'task-current', 40, 'session-1');

    expect(columnNamesIn(whereCalls[0])).toContain('session_id');
  });

  it('does not filter by session when projectHistoryForPrompt is called with no sessionId', async () => {
    const { repository, whereCalls } = repo([[], [{ tasks: 1, conversations: 1 }]]);

    // A chat/change task outside any conversation (no session_id at all) has
    // nothing to exclude - every other request in the project is equally
    // "another conversation" to it.
    await repository.projectHistoryForPrompt('project-1', 'task-current', 40, null);

    expect(columnNamesIn(whereCalls[0])).not.toContain('session_id');
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

  /**
   * Found live (not a test gap, a real duplicate): a project with every task
   * in one session sent that session's turns twice per new request - once in
   * full via conversationContext (ADR-074), once summarised via this index
   * (ADR-080) - because projectHistoryForPrompt only excluded the current
   * task, never its conversation. The fix passes the task's own sessionId
   * through so the index covers every OTHER conversation instead.
   */
  it('excludes the current session from the project index, not just the current task', () => {
    const block = workflow.slice(workflow.indexOf('private async projectHistory'));
    const call = block.slice(0, block.indexOf('return buildProjectHistory'));
    expect(call).toMatch(/snapshot\.sessionId/);
  });
});

