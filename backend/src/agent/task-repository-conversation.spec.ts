import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRepository } from './task-repository';
import type { DatabaseService } from '../core/database/database.service';
import type { AuditService } from '../core/audit/audit.service';
import type { TaskEventPublisher } from '../core/events/task-event-publisher.service';
import type { GitCredentialsService } from '../modules/settings/git-credentials.service';

/**
 * ADR-074: a chat task reads the earlier turns of its own conversation.
 *
 * The defect: `ChatLoopInput.conversationContext` was declared by ADR-029 and
 * rendered by `ChatLoop.buildParts`, but `AgentWorkflow.implementChat` never
 * passed it, and nothing read a session's earlier tasks. Every message in a
 * conversation reached the model as if it were the first.
 */
describe('TaskRepository.loadConversationTurns (ADR-074)', () => {
  function repo(selects: unknown[][]) {
    const queue = [...selects];
    const chain = (rows: unknown[]) => {
      const self: Record<string, unknown> = {};
      for (const method of ['from', 'where', 'orderBy']) self[method] = () => self;
      self.limit = async () => rows;
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

  it('reads nothing for a task outside a conversation', async () => {
    const { repository, select } = repo([]);
    expect(await repository.loadConversationTurns('task-1', null, 20)).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('maps earlier tasks to turns, with plan summary and modified paths', async () => {
    const { repository } = repo([
      [{ createdAt: new Date('2026-10-19T10:05:00Z') }],
      [
        {
          reference: 'task_1',
          kind: 'chat',
          status: 'completed',
          prompt: 'What does this module do?',
          answer: 'It adds a delivery note.',
          failureReason: null,
          plan: null,
          modifiedFiles: [],
          createdAt: new Date('2026-10-19T10:00:00Z'),
        },
        {
          reference: 'task_2',
          kind: 'change',
          status: 'completed',
          prompt: 'Add the field',
          answer: 'The change was committed and pushed.',
          failureReason: null,
          plan: { summary: 'Add delivery_note to stock.picking' },
          modifiedFiles: [{ path: 'models/stock_picking.py' }, { nope: true }],
          createdAt: new Date('2026-10-19T10:02:00Z'),
        },
      ],
    ]);

    const turns = await repository.loadConversationTurns('task-3', 'session-1', 20);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ reference: 'task_1', answer: 'It adds a delivery note.' });
    expect(turns[1]).toMatchObject({
      reference: 'task_2',
      kind: 'change',
      planSummary: 'Add delivery_note to stock.picking',
      modifiedPaths: ['models/stock_picking.py'],
    });
  });

  it('returns nothing when the current task no longer exists', async () => {
    const { repository } = repo([[]]);
    expect(await repository.loadConversationTurns('gone', 'session-1', 20)).toEqual([]);
  });
});

describe('AgentWorkflow passes the conversation to the chat loop (ADR-074)', () => {
  const workflow = readFileSync(join(__dirname, 'orchestration', 'agent-workflow.ts'), 'utf8');
  const repository = readFileSync(join(__dirname, 'task-repository.ts'), 'utf8');

  it('fills conversationContext in implementChat', () => {
    const block = workflow.slice(workflow.indexOf('private async implementChat'));
    const runCall = block.slice(0, block.indexOf('this.failOnModelError'));
    expect(runCall).toMatch(/conversationContext: await this\.conversationContext\(snapshot\)/);
  });

  it('never fails the answer because history could not be read', () => {
    const block = workflow.slice(workflow.indexOf('private async conversationContext'));
    expect(block.slice(0, 1200)).toMatch(/catch \(error\)[\s\S]*?return \[\];/);
  });

  it('scopes the history to the same session and to tasks created before this one', () => {
    const block = repository.slice(repository.indexOf('async loadConversationTurns'));
    expect(block).toMatch(/eq\(agentTasks\.sessionId, sessionId\)/);
    expect(block).toMatch(/lt\(agentTasks\.createdAt, current\.createdAt\)/);
  });

  it('gives change-request planning the same history, on both planning paths', () => {
    // A change request after a discussion ("now build what we discussed") is the
    // other half of the reported defect: without this the planner saw only the
    // new prompt.
    const planCalls = workflow.split('this.planner.create').slice(1);
    expect(planCalls).toHaveLength(2);
    for (const call of planCalls) {
      const args = call.slice(0, call.indexOf('});'));
      expect(args).toMatch(/conversationContext: await this\.conversationContext\(snapshot\)/);
    }

    const planner = readFileSync(
      join(__dirname, 'orchestration', 'model-agent-planner.ts'),
      'utf8',
    );
    const rendered = planner.match(/\.\.\.\(input\.conversationContext \?\? \[\]\)/g) ?? [];
    expect(rendered).toHaveLength(2);
  });
});
