# ADR-092: A resumed task sees its own prior progress

- Status: Accepted
- Date: 3 November 2026
- Milestone: Phase 5 (connected-server estate)

## Context

task_131131: a plain business request ("Sales Order approval based on a
max-discount field on each customer and the top-level product category")
with no mention of "Automation Rule" or "Server Action" anywhere in it. The
model correctly inferred it needed both: it created the two supporting
fields (`x_max_discount` on `res.partner` and on `product.category`) through
the RPC tools, then navigated the signed-in browser towards Settings >
Technical > Automation Rules on its own initiative, with no hint from the
prompt that this is where that capability lives.

It then tried `browser_click`, which required the `browser_session`
approval (ADR-087). The person approved it seven seconds later. The task
resumed - and never attempted the click again, or anything resembling
continuing the Automation Rule. It answered as though the task were already
complete, having done only the two fields.

Root cause: `AgentWorkflow.step()` routes `waiting_approval` to
`resumeFromApproval`, which (for `browser_session`, `chat_edit`,
`odoo_record_write`, `odoo_model_create`, `file_deletion`) transitions the
task straight back to `implementing`. That re-enters `implementChat`,
`implementOdooOnline` or `implement` from the top: same prompt, same
approved plan (for a `change` task), a brand new call into
`ChatLoop.run`/`ModelImplementationLoop.run` with no memory of anything the
model did in the run that got suspended. `conversationContext` (ADR-074)
cannot help - it is explicitly *other* turns in the conversation, excluding
the one currently running, by design (a task is not supposed to see its own
future). The model's own actions before the pause simply were not part of
any prompt it was ever shown again.

This reproduces for any write tool gated by approval mid-implementation,
not only `browser_session` - the same shape of bug would show on a `change`
task that needed two separate `odoo_record_write` approvals in one run, or
a chat that wrote one file, got approved, and needed a second write.
`task_131131`'s own tool log happened to make it legible: `odoo_create_field`
x2 (succeeded) -> `browser_navigate` x2 (succeeded) -> `browser_click`
(denied pending approval, approved 7s later) -> the model's next and only
further actions were re-reading fields it had already created.

## Decision

Added `TaskRepository.loadPriorActions(taskId, maxActions)`: this task's own
successful tool calls, oldest first, read straight off `agent_actions`.
Deliberately successes only - a failed or denied attempt is not progress to
repeat, and showing it again would just invite the model to re-litigate a
call the platform already settled.

`buildPriorProgress` (`orchestration/prior-progress.ts`) renders that list
as one prompt part, one line per call (`N. tool_name(input) -> output`,
each side-capped for length), with an explicit instruction: "You already
made these tool calls earlier in this same task, before being paused for a
human approval. Do not repeat them or redo work they already finished -
continue from where they left off towards what the approval you just
received was for." Not marked `untrusted`: this is the platform's own audit
log of calls that already passed the permission validator, the same trust
level as the prompt itself, not content a person or a file supplied.

Wired into all three places a task's implementation can resume:
`implementChat` (chat tasks), `implementOdooOnline` (odoo_online change
tasks) and `implement` (repository-based change tasks). On a task's first
pass through implementation this is simply empty - `loadPriorActions` finds
nothing before the first tool call ever ran - so the prompt is unchanged
from before this ADR for a task that never suspends. It only has something
to say exactly when `resumeFromApproval` re-enters implementation, which is
the one case that was broken.

Same failure rule as the other context builders (`conversationContext`,
`projectHistory`): a read error degrades to "no prior progress" rather than
failing the task - the model reasons as if this were its first attempt, the
behaviour every task already had before this ADR.

## Consequences

- A task that suspends mid-implementation for an approval - a browser
  action, a record write, a new model, a file deletion, a chat edit - comes
  back from resumption knowing what it already did, and is told explicitly
  to continue rather than restart.
- This is layered on top of, not a substitute for, ADR-090 and ADR-091: all
  three were needed for task_131131's actual request to go from "the agent
  refuses the request outright" (pre-ADR-090: blocked by the browser
  deny-list) to "the agent tries, loses its own progress on resume, and
  quietly stops short" (post-ADR-090/091, pre-this-ADR) to a model that can
  plausibly carry the Automation Rule through to completion.
- The prompt part grows with how many tool calls a task made before
  suspending; `DEFAULT_PRIOR_PROGRESS_BUDGET` (60 actions, 8,000 characters)
  caps it the same way `DEFAULT_CONVERSATION_BUDGET` caps conversation
  history, with the overflow noted rather than silently dropped.
- Not yet verified end-to-end against a real Automation Rule / Server
  Action build in the browser (typing Python into Odoo's code editor,
  specifically) - this ADR fixes the resumption memory gap that stopped the
  model from trying again after approval; it does not by itself prove the
  browser can complete that specific screen's workflow.
- Tests: `prior-progress.spec.ts` (new, 6 cases covering ordering, the
  instruction text, the omitted-count footer and truncation) and
  `task-repository-prior-actions.spec.ts` (new, 5 cases covering the
  null-tool-name filter, null input/output defaulting, the `maxActions`
  cap and the empty case).
