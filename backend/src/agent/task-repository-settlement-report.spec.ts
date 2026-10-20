import { TaskRepository } from './task-repository';
import type { DatabaseService } from '../core/database/database.service';
import type { AuditService } from '../core/audit/audit.service';
import type { TaskEventPublisher } from '../core/events/task-event-publisher.service';
import type { GitCredentialsService } from '../modules/settings/git-credentials.service';

/**
 * ADR-081: the thread's reply is composed from what a task actually recorded,
 * not the last status line.
 *
 * The defect: a change task never called `saveAnswer()` - that's chat-only.
 * `transition()`'s old `coalesce(answer, message)` gave it the completion
 * message instead, which for a failed push was a raw git/SSH error dump, and
 * for a committed push was "Branch Staging was pushed to the remote
 * repository at commit 4e389b49." - a status line, not what was built, which
 * files changed, or why it failed. Reported verbatim: "kalo ngubah code, yaudah
 * gak dapet respon yang bagus, cuma di kasih tau kalo udah di push aja".
 */
describe('TaskRepository.transition composes a settlement reply (ADR-081)', () => {
  function repo(row: Record<string, unknown> | null) {
    const sets: Record<string, unknown>[] = [];

    const database = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => (row ? [row] : []),
            }),
          }),
        }),
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

    const repository = new TaskRepository(database, events, audit, gitCredentials);
    return { repository, sets };
  }

  function baseRow(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'change',
      prompt: 'Write the trip KPI dev task for the delivery dashboard',
      answer: null,
      plan: { summary: 'Write the trip KPI dev task' },
      modifiedFiles: [
        { path: 'docs/delivery-trip-kpi-dev-task.md', change: 'added', linesAdded: 40, linesRemoved: 0 },
      ],
      diffStats: { linesAdded: 40, linesRemoved: 0 },
      testResults: null,
      commitHash: '4e389b494ac6f2fc97af272ea4c8b4edf698ef02',
      branch: 'Staging',
      ...overrides,
    };
  }

  it('reports what changed and that the push failed, not a raw git error alone', async () => {
    const { repository, sets } = repo(baseRow());

    await repository.transition('task-1', 'pushing', 'failed', {
      failureReason:
        "git push failed (exit 1): Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\r\n" +
        'error: atomic push failed for ref refs/heads/Staging. status: 2\n' +
        '! [rejected]        Staging -> Staging (non-fast-forward)',
    });

    const answer = String(sets[0].answer);
    expect(answer).toContain('docs/delivery-trip-kpi-dev-task.md');
    expect(answer).toContain('4e389b49');
    expect(answer).toContain('did not reach the remote');
    expect(answer).toContain('non-fast-forward');
    // The SSH host-key notice is noise, not part of why the push failed.
    expect(answer).not.toContain('Permanently added');
  });

  it('reports the files, lines and commit for a push that succeeded', async () => {
    const { repository, sets } = repo(baseRow());

    await repository.transition('task-1', 'pushing', 'completed', {
      message: 'Branch Staging was pushed to the remote repository at commit 4e389b49.',
    });

    const answer = String(sets[0].answer);
    expect(answer).toContain('docs/delivery-trip-kpi-dev-task.md');
    expect(answer).toContain('+40');
    expect(answer).toContain('pushed');
    expect(answer).toContain('4e389b49');
    expect(answer).toContain('Staging');
  });

  it('replies in Indonesian when the request was Indonesian', async () => {
    const { repository, sets } = repo(baseRow({ prompt: 'tolong buatkan devtask trip KPI dong' }));

    await repository.transition('task-1', 'pushing', 'completed', {
      message: 'Branch Staging was pushed to the remote repository at commit 4e389b49.',
    });

    expect(String(sets[0].answer)).toContain('Selesai');
  });

  it('leaves a plain chat answer untouched: the answer IS the reply', async () => {
    const { repository, sets } = repo(
      baseRow({ kind: 'chat', answer: 'It adds a delivery note.', modifiedFiles: [], commitHash: null }),
    );

    await repository.transition('task-1', 'testing', 'completed', { message: 'Answered.' });

    // Not overwritten and not coalesced: the column is not part of the update.
    expect(sets[0]).not.toHaveProperty('answer');
  });

  it('composes a reply for a chat that wrote and committed, not just its own answer', async () => {
    const { repository, sets } = repo(
      baseRow({ kind: 'chat', answer: 'Done - added the field.', branch: 'task-branch' }),
    );

    await repository.transition('task-1', 'pushing', 'completed', {
      message: 'Branch task-branch was pushed to the remote repository at commit 4e389b49.',
    });

    const answer = String(sets[0].answer);
    expect(answer).toContain('Done - added the field.');
    expect(answer).toContain('docs/delivery-trip-kpi-dev-task.md');
  });

  it('falls back to the status line when the row cannot be read', async () => {
    const { repository, sets } = repo(null);

    await repository.transition('task-1', 'committing', 'completed', {
      message: 'The approved change is committed and pushed like a change task.',
    });

    const sqlObject = sets[0].answer as { queryChunks: unknown[] };
    const parts = sqlObject.queryChunks
      .map((chunk) => (typeof chunk === 'string' ? chunk : (chunk as { value?: unknown })?.value))
      .filter((part) => typeof part === 'string')
      .join(' ');
    expect(parts).toContain('The approved change is committed and pushed like a change task.');
  });

  it('never fails the transition itself when the row read throws', async () => {
    const sets: Record<string, unknown>[] = [];
    const database = {
      db: {
        select: () => {
          throw new Error('connection reset');
        },
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

    const repository = new TaskRepository(
      database,
      { publish: async () => undefined } as unknown as TaskEventPublisher,
      { record: async () => undefined } as unknown as AuditService,
      {} as unknown as GitCredentialsService,
    );

    const applied = await repository.transition('task-1', 'testing', 'completed', {
      message: 'Answered.',
    });

    expect(applied).toBe(true);
  });
});
