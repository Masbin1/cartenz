/**
 * The orchestration contract (ADR-011).
 *
 * The API depends on this interface and nothing more. The foundation binds
 * QueueAgentOrchestrator over BullMQ; a Temporal implementation will be bound in
 * its place without changes to any caller.
 *
 * Only three operations exist, and the shape of them is what makes the
 * substitution possible: start, resume and cancel. Notably there is no "run"
 * that returns a result: a task takes minutes and pauses for human approval, so
 * no caller may ever hold a handle across it.
 */
export interface AgentOrchestrator {
  /**
   * Enqueues a created task for execution. Returns once the work is durably
   * queued, not once it is done.
   */
  start(taskId: string): Promise<void>;

  /**
   * Resumes a task suspended at an approval. Called by the approvals module
   * after a decision is recorded; the decision itself is already persisted, so a
   * failure here loses the resumption, not the decision.
   */
  resume(taskId: string, reason: ResumeReason): Promise<void>;

  /**
   * Requests cancellation. Cancellation is cooperative: the workflow observes
   * the task's status at each step boundary and stops. A step already in flight
   * is allowed to finish, so the platform never abandons a partially applied
   * effect.
   */
  cancel(taskId: string): Promise<void>;
}

export type ResumeReason = 'approval_granted' | 'approval_rejected';

export const AGENT_ORCHESTRATOR = 'AGENT_ORCHESTRATOR';
