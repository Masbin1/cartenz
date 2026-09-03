import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every call into the implementation loop must carry the execution mode.
 *
 * This exists because of a real defect. `implement()` omitted `executionMode`,
 * so `offeredTools` filtered out every tool declaring `modes` - which is all of
 * the repository, git, odoo and validation tools. The model was handed an empty
 * tool list, replied that it could not do anything, and the task failed as "made
 * no change to the working tree": a message that blames the model for a caller's
 * missing argument. Planning was unaffected because it reads the mode from the
 * snapshot separately, so the failure only appeared after a person had already
 * approved a plan.
 *
 * The source is read rather than the loop run, because what failed was one
 * missing property on an object literal.
 */
describe('the implementation loop call sites', () => {
  const source = readFileSync(join(__dirname, 'agent-workflow.ts'), 'utf8');

  /** The argument object of each `implementationLoop.run({ ... })` call. */
  const calls = [...source.matchAll(/implementationLoop\.run\(\{([\s\S]*?)\n      \}\)/g)].map(
    ([, body]) => body,
  );

  it('finds the call sites, so a refactor cannot silently empty this test', () => {
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('passes executionMode at every call site', () => {
    const missing = calls.filter((body) => !/executionMode:/.test(body));
    expect(missing).toEqual([]);
  });
});

/**
 * On-premise must reach the push gate like every other repository mode (ADR-028:
 * "real push becomes required for odoo_sh and on_premise").
 *
 * This exists because `commit()` used to short-circuit on-premise straight to
 * `completed` with "pushing to its remote is not yet supported". A person who
 * asked for a push got a commit that never left their machine and a message
 * saying that was intended, which reads as a decision rather than a gap.
 */
describe('the commit stage', () => {
  const source = readFileSync(join(__dirname, 'agent-workflow.ts'), 'utf8');

  it('does not complete on-premise before the push gate is reached', () => {
    // The exact shape of the defect: a transition to completed whose reason is
    // that on-premise cannot push.
    expect(source).not.toMatch(/not yet supported/i);
    expect(source).not.toMatch(/No push was made/i);
  });

  it('leaves the push behind the approval gate rather than granting it by mode', () => {
    // The guarantee that must survive: on-premise is routed to the same gate, not
    // around it. `pushing` is only ever reached through an existing approval.
    const gate = /grantedApprovals\.includes\('git_push'\)\)\s*\{\s*return this\.tasks\.transition\(\s*snapshot\.taskId,\s*'committing',\s*'pushing'/;
    expect(source).toMatch(gate);
  });
});
