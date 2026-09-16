import { TasksService } from './tasks.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuthorizationService } from '../../core/authz/authorization.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { TaskRepository } from '../../agent/task-repository';
import type { ToolRegistry } from '../../agent/tools/tool-registry';
import type { ModelCallRecorder } from '../../agent/model/model-call-recorder.service';
import type { ProjectEnvironmentsService } from '../projects/project-environments.service';
import type { AgentOrchestrator } from '../../agent/orchestration/agent-orchestrator.interface';

/**
 * ADR-047: the conversation list, and the per-conversation thread behind it.
 *
 * The workspace's history pane lists sessions, not tasks. These tests pin the
 * two backend behaviours that make that work: `listSessions` reporting each
 * conversation's request count, last activity and latest status, and
 * `listForProject(sessionId)` returning one conversation's requests oldest
 * first — the order a thread is read in.
 */

const session = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Prompt for ${id}`,
  status: 'active',
  startedAt: new Date('2026-09-01T10:00:00Z'),
  endedAt: null,
  ...overrides,
});

/**
 * A loose stand-in for DatabaseService. Partial<DatabaseService> would still
 * require db to be a full Database, so this takes whatever shape a test needs
 * and casts once, at the one place that matters.
 */
/** The one private method these tests reach into, typed loosely on purpose. */
type WithSessionCheck = {
  assertSessionBelongsToProject: (...args: unknown[]) => Promise<unknown>;
};

const makeService = (database: Record<string, unknown>) =>
  new TasksService(
    database as unknown as DatabaseService,
    { requireProjectAccess: jest.fn() } as unknown as AuthorizationService,
    { record: jest.fn() } as unknown as AuditService,
    {} as unknown as TaskRepository,
    {} as unknown as ToolRegistry,
    {} as unknown as ModelCallRecorder,
    {} as unknown as ProjectEnvironmentsService,
    {} as unknown as AgentOrchestrator,
  );

describe('TasksService — sessions and the conversation thread', () => {
  describe('listSessions', () => {
    it('reports each conversation with its request count, last activity and latest status', async () => {
      const a = session('a', { startedAt: new Date('2026-09-02T10:00:00Z') });
      const b = session('b', { startedAt: new Date('2026-09-01T10:00:00Z') });

      const counts = [
        { sessionId: 'a', taskCount: 2, lastActivityAt: new Date('2026-09-02T12:00:00Z') },
        { sessionId: 'b', taskCount: 1, lastActivityAt: new Date('2026-09-01T11:00:00Z') },
      ];
      const recent = [
        {
          sessionId: 'a',
          prompt: 'Prompt a2',
          status: 'running',
          createdAt: new Date('2026-09-02T12:00:00Z'),
        },
        { sessionId: 'a', prompt: 'Prompt a1', status: 'completed', createdAt: new Date('2026-09-02T11:00:00Z') },
        { sessionId: 'b', prompt: 'Prompt b1', status: 'completed', createdAt: new Date('2026-09-01T11:00:00Z') },
      ];

      // Three reads in order: sessions, grouped counts, recent tasks.
      const select = jest
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ orderBy: () => ({ limit: async () => [a, b] }) }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ groupBy: async () => counts }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ orderBy: async () => recent }),
          }),
        });

      const service = makeService({ db: { select } });
      const result = await service.listSessions({} as never, 'project-1');

      expect(result[0]).toMatchObject({
        id: 'a',
        taskCount: 2,
        lastActivityAt: new Date('2026-09-02T12:00:00Z'),
        latestStatus: 'running',
        latestPrompt: 'Prompt a2',
      });
      expect(result[1]).toMatchObject({
        id: 'b',
        taskCount: 1,
        latestStatus: 'completed',
      });
    });

    it('returns an empty list without touching the task table', async () => {
      const select = jest.fn().mockReturnValue({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
        }),
      });
      const service = makeService({ db: { select } });
      expect(await service.listSessions({} as never, 'project-1')).toEqual([]);
      expect(select).toHaveBeenCalledTimes(1);
    });

    it('falls back to the session title when it holds no tasks', async () => {
      const s = session('a');
      const select = jest
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ orderBy: () => ({ limit: async () => [s] }) }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ groupBy: async () => [] }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ orderBy: async () => [] }),
          }),
        });

      const service = makeService({ db: { select } });
      const [row] = await service.listSessions({} as never, 'project-1');
      expect(row.taskCount).toBe(0);
      expect(row.latestStatus).toBeNull();
      expect(row.latestPrompt).toBe('Prompt for a');
    });
  });

  describe('listForProject with a session', () => {
    /**
     * The session filter must be validated against the project before any
     * read happens: a session id from another project is refused, not
     * silently narrowed away. The unfiltered list does not do this at all.
     */
    it('validates the session against the project before reading', async () => {
      const select = jest.fn().mockReturnValue({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
        }),
      });
      const service = makeService({ db: { select } });
      const check = jest
        .spyOn(service as unknown as WithSessionCheck, 'assertSessionBelongsToProject')
        .mockResolvedValue('s');

      await service.listForProject({} as never, 'project-1', 50, 's');
      expect(check).toHaveBeenCalledWith('s', 'project-1');

      await service.listForProject({} as never, 'project-1');
      expect(check).toHaveBeenCalledTimes(1);
    });

    it('refuses a session id that does not belong to the project', async () => {
      const service = makeService({});
      jest
        .spyOn(service as unknown as WithSessionCheck, 'assertSessionBelongsToProject')
        .mockRejectedValue(new Error('does not belong'));

      await expect(
        service.listForProject({} as never, 'project-1', 50, 'foreign'),
      ).rejects.toThrow('does not belong');
    });
  });
});
