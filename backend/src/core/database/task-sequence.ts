/**
 * Concurrency guard for the per-task `sequence` columns on `agent_task_events`
 * and `agent_actions`.
 *
 * Both tables allocate their sequence with `select coalesce(max(sequence),0)+1`
 * scoped to the task, and both carry a unique index on `(task_id, sequence)`.
 * That subquery is not atomic: when the implementation loop fires several events
 * or actions for one task in quick succession, two inserts can read the same
 * max and compute the same next value, and the second to commit trips the unique
 * constraint with `duplicate key value violates unique constraint`. A single
 * lost event then breaks the loop and fails the task.
 *
 * Rather than serialise every writer behind a lock, or introduce a counter row
 * that would need its own migration and its own contention, the collision is
 * simply retried. The insert is a single autocommit statement, so a retry
 * re-runs the max subquery and observes the row the competing insert has by then
 * committed, landing on the next free value. The unique index stays the
 * authority; the sequence stays monotonic and unique per task, and gaps remain
 * tolerable exactly as before.
 */

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Runs an insert, retrying when it collides on the named per-task sequence
 * constraint. Any other failure, and exhaustion of the attempt budget, is
 * rethrown so a genuine problem is never swallowed.
 */
export async function withSequenceRetry<T>(
  operation: () => Promise<T>,
  constraint: string,
  attempts = 8,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isSequenceCollision(error, constraint)) throw error;
    }
  }
}

/**
 * A unique-violation on the specific per-task sequence index. Matched on the
 * SQLSTATE plus the constraint name so an unrelated unique violation - a
 * duplicate task reference, say - is not silently retried. The name is checked
 * on both the `constraint` field node-postgres populates and, defensively, in
 * the message, since the field is not guaranteed on every error path.
 */
function isSequenceCollision(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; constraint?: string; message?: string };
  if (candidate.code !== UNIQUE_VIOLATION) return false;
  return candidate.constraint === constraint || (candidate.message ?? '').includes(constraint);
}
