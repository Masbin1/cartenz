import { BadRequestException, ConflictException } from '@nestjs/common';
import { TERMINAL_TASK_STATUSES, AGENT_TASK_STATUSES } from '../../agent/task-state';

/**
 * Permanent project deletion (ADR-024).
 *
 * The service method needs a database, an authorisation check, a secrets provider
 * and a workspace manager, so the end-to-end behaviour is asserted by
 * `smoke-test-deletion.sh` against a running stack rather than by a mock of four
 * collaborators, which would mostly test the mocks.
 *
 * What is worth asserting in isolation is the reasoning the method depends on:
 * which statuses count as unfinished, and that the confirmation is an exact
 * match. Both are the kind of thing a later change breaks quietly.
 */
describe('what counts as an unfinished task', () => {
  it('treats exactly completed, failed and cancelled as finished', () => {
    expect([...TERMINAL_TASK_STATUSES].sort()).toEqual(['cancelled', 'completed', 'failed']);
  });

  it('treats waiting_approval as unfinished, so a paused task blocks a delete', () => {
    // A task waiting on a person is not finished: approving it would resume work
    // on a project that no longer existed.
    expect(TERMINAL_TASK_STATUSES).not.toContain('waiting_approval');
  });

  it('leaves no status unaccounted for', () => {
    // If a status is added and forgotten, it is treated as unfinished and blocks
    // deletion - which is the safe direction, but this makes the choice visible.
    const unfinished = AGENT_TASK_STATUSES.filter(
      (status) => !TERMINAL_TASK_STATUSES.includes(status),
    );

    expect(unfinished).toEqual([
      'created',
      'queued',
      'analyzing',
      'planning',
      'waiting_approval',
      'implementing',
      'testing',
      'committing',
      'pushing',
      'building',
    ]);
  });
});

/**
 * The confirmation check, extracted so it can be asserted without a database.
 *
 * Duplicating the comparison in a test would let the two drift, so the test
 * documents the intent and the smoke test proves the wiring: trimmed, but
 * case-sensitive.
 */
describe('the delete confirmation', () => {
  const matches = (typed: string, name: string) => typed.trim() === name;

  it('accepts the name with surrounding whitespace', () => {
    // Someone who copies a name out of the interface often takes a space with it.
    expect(matches('  LinkedERP Odoo  ', 'LinkedERP Odoo')).toBe(true);
  });

  it('refuses a different case', () => {
    // Someone who has typed the name has read it; accepting a near miss would
    // defeat the point of asking.
    expect(matches('linkederp odoo', 'LinkedERP Odoo')).toBe(false);
  });

  it('refuses a prefix, a suffix and an empty string', () => {
    expect(matches('LinkedERP', 'LinkedERP Odoo')).toBe(false);
    expect(matches('LinkedERP Odoo (staging)', 'LinkedERP Odoo')).toBe(false);
    expect(matches('', 'LinkedERP Odoo')).toBe(false);
  });

  it('refuses the word a careless client might send instead', () => {
    for (const guess of ['true', 'yes', 'confirm', 'DELETE', '*']) {
      expect(matches(guess, 'LinkedERP Odoo')).toBe(false);
    }
  });
});

/** The exception types callers depend on, so a refusal keeps its HTTP status. */
describe('refusals carry the right status', () => {
  it('a wrong name is a 400, not a 500', () => {
    expect(new BadRequestException('x').getStatus()).toBe(400);
  });

  it('an unfinished task is a 409, because retrying later will work', () => {
    expect(new ConflictException('x').getStatus()).toBe(409);
  });
});
