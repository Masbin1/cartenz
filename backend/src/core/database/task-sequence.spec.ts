import { withSequenceRetry } from './task-sequence';

/**
 * Per-task sequence retry (agent_task_events / agent_actions).
 *
 * The sequence is allocated with a non-atomic `max+1` subquery guarded only by a
 * unique index, so a burst of inserts for one task can collide. The real defect
 * this pins was a lost tool event: one insert tripped
 * `agent_task_events_task_sequence_unique`, the implementation loop broke, and
 * the task failed. `withSequenceRetry` must absorb exactly that collision and
 * nothing else.
 *
 * The database itself is not exercised here; a full concurrent-insert test needs
 * a live Postgres and belongs to integration. These tests fix the retry
 * contract - which error is retried, which is rethrown, and that a clean insert
 * is untouched - which is where the bug lived.
 */
describe('withSequenceRetry', () => {
  const constraint = 'agent_task_events_task_sequence_unique';

  /** A node-postgres unique violation on the given constraint. */
  function uniqueViolation(name = constraint) {
    return Object.assign(new Error(`duplicate key value violates unique constraint "${name}"`), {
      code: '23505',
      constraint: name,
    });
  }

  it('returns the result and runs once when the insert does not collide', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    await expect(withSequenceRetry(operation, constraint)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a sequence collision and succeeds once a slot is free', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValue('ok');

    await expect(withSequenceRetry(operation, constraint)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up and rethrows after exhausting the attempt budget', async () => {
    const operation = jest.fn().mockRejectedValue(uniqueViolation());

    await expect(withSequenceRetry(operation, constraint, 3)).rejects.toMatchObject({
      code: '23505',
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry a unique violation on a different constraint', async () => {
    const operation = jest.fn().mockRejectedValue(uniqueViolation('agent_tasks_reference_unique'));

    await expect(withSequenceRetry(operation, constraint)).rejects.toMatchObject({
      constraint: 'agent_tasks_reference_unique',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unrelated error', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('connection reset'));

    await expect(withSequenceRetry(operation, constraint)).rejects.toThrow('connection reset');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('matches the constraint from the message when the field is absent', async () => {
    const bare = Object.assign(
      new Error(`duplicate key value violates unique constraint "${constraint}"`),
      { code: '23505' },
    );
    const operation = jest.fn().mockRejectedValueOnce(bare).mockResolvedValue('ok');

    await expect(withSequenceRetry(operation, constraint)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
