import { TaskRepository } from './task-repository';
import type { DatabaseService } from '../core/database/database.service';
import type { AuditService } from '../core/audit/audit.service';
import type { TaskEventPublisher } from '../core/events/task-event-publisher.service';
import type { GitCredentialsService } from '../modules/settings/git-credentials.service';

/**
 * A "change" task (as opposed to "chat") never called `saveAnswer()` - that
 * method is chat-only. Its only completion message was written to the
 * append-only action log via `narrate()`, which the Activity tab reads but
 * the conversation/chat surface does not. The result: a change task that
 * succeeded, or failed, produced a status change in the UI and nothing in
 * the chat box - exactly what was reported ("sukses ataupun error, gak ada
 * respon di chat box, adanya cuma di activity nya").
 *
 * `transition()`'s `coalesce(answer, message)` on reaching `completed` is
 * the fix: every task kind gets a line in `answer` the first time it
 * completes, without ever overwriting a chat's own `saveAnswer()` call made
 * earlier in the same run order (`options.message` on the final transition
 * is the question-free fallback, not the thing to prefer over a real reply).
 */
describe('TaskRepository.transition — answer visibility for every task kind (ADR-029 extension)', () => {
  function repoWithCapturedPatch() {
    const sets: Record<string, unknown>[] = [];

    const database = {
      db: {
        update: () => ({
          set: (patch: Record<string, unknown>) => {
            sets.push(patch);
            return {
              where: () => ({
                returning: async () => [
                  { id: 'task-1', reference: 'task_1', projectId: 'project-1' },
                ],
              }),
            };
          },
        }),
        insert: () => ({ values: async () => ({}) }),
      },
    } as unknown as DatabaseService;

    const events = { publish: async () => undefined } as unknown as TaskEventPublisher;
    const audit = { record: async () => undefined } as unknown as AuditService;
    const gitCredentials = {} as unknown as GitCredentialsService;

    const repo = new TaskRepository(database, events, audit, gitCredentials);
    return { repo, sets };
  }

  it('gives a change task completion message the same visibility as a chat answer', async () => {
    const { repo, sets } = repoWithCapturedPatch();

    const applied = await repo.transition('task-1', 'committing', 'completed', {
      message: 'The change was committed and pushed.',
    });

    expect(applied).toBe(true);
    expect(sets).toHaveLength(1);
    // A raw SQL fragment (drizzle's `sql` template), not a plain string: it
    // must defer to whatever is already in the column, never overwrite it
    // outright. This checks it is a SQL object carrying the message, not a
    // plain string that would clobber an existing answer unconditionally.
    expect(sets[0].answer).toBeDefined();
    expect(typeof sets[0].answer).not.toBe('string');
    const sqlObject = sets[0].answer as { queryChunks: unknown[] };
    const parts = sqlObject.queryChunks
      .map((chunk) => (typeof chunk === 'string' ? chunk : (chunk as { value?: unknown })?.value))
      .filter((part) => typeof part === 'string')
      .join(' ');
    expect(parts).toContain('The change was committed and pushed.');
  });

  it('does not touch answer on a non-completing transition', async () => {
    const { repo, sets } = repoWithCapturedPatch();

    await repo.transition('task-1', 'analyzing', 'planning', {
      message: 'Creating implementation plan...',
    });

    expect(sets).toHaveLength(1);
    expect(sets[0].answer).toBeUndefined();
  });

  it('does not touch answer when completed with no message', async () => {
    const { repo, sets } = repoWithCapturedPatch();

    await repo.transition('task-1', 'testing', 'completed', {});

    expect(sets).toHaveLength(1);
    expect(sets[0].answer).toBeUndefined();
  });
});
