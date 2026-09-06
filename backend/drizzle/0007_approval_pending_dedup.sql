-- A task may have only one pending approval for a given action (ADR-029).
-- ApprovalService.request() dedupes with a SELECT-then-INSERT that is not
-- atomic: two parallel requests for the same (task, action) can both see no
-- existing pending row and both insert, leaving a second pending approval that
-- keeps the task suspended after the first is decided. This partial unique
-- index makes the dedup a fact of the schema rather than of a read-modify-write.
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_task_action_pending_unique"
  ON "approvals" ("task_id", "action")
  WHERE "status" = 'pending';
