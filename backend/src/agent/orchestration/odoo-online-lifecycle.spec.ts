import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canTransition, type AgentTaskStatus } from '../task-state';

/**
 * The Odoo Online path must move through the lifecycle, not around it.
 *
 * This exists because of a real defect with a real cost. The implementation step
 * transitioned `implementing -> completed`, which the state table does not permit.
 * The throw happened *after* the instance had already been written, so the queue
 * job failed and BullMQ retried the whole step - applying the same change to a
 * live customer instance three times before the task was cancelled. An illegal
 * transition in a mode whose effects are immediate and external is not a tidiness
 * problem; it is duplicate writes to production.
 *
 * The test reads the workflow source rather than running it. Running the step
 * needs a model provider, a live instance and a queue; what actually failed was a
 * pair of status strings, and those can be checked directly. Every transition the
 * file asks for is verified against the one table that decides.
 */
describe('the agent workflow lifecycle', () => {
  const source = readFileSync(join(__dirname, 'agent-workflow.ts'), 'utf8');

  /** Every `transition(taskId, from, to, ...)` the workflow performs. */
  const declared = [
    ...source.matchAll(/transition\(\s*[^,]+,\s*'([a-z_]+)',\s*'([a-z_]+)'/g),
  ].map(([, from, to]) => ({ from: from as AgentTaskStatus, to: to as AgentTaskStatus }));

  it('finds the transitions to check, so a rename cannot silently empty this test', () => {
    expect(declared.length).toBeGreaterThan(10);
  });

  it('never asks for a transition the state table refuses', () => {
    const illegal = declared
      .filter((edge) => !canTransition(edge.from, edge.to))
      .map((edge) => `${edge.from} -> ${edge.to}`);

    expect(illegal).toEqual([]);
  });

  it('reaches completed from testing on the Odoo Online path, not from implementing', () => {
    // The specific shape of the defect: implementing must hand off to testing,
    // which is the state that may complete.
    expect(canTransition('implementing', 'completed')).toBe(false);
    expect(canTransition('implementing', 'testing')).toBe(true);
    expect(canTransition('testing', 'completed')).toBe(true);
  });
});
