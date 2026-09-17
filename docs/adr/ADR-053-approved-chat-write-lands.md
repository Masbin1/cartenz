# ADR-053: An approved chat write lands — committed and pushed like a change task

- Status: Accepted
- Date: 18 September 2026
- Milestone: Phase 5 (review)

Builds on ADR-029 (conversational mode with the `chat_edit` gate), ADR-021
(push safety), ADR-046 (a task works on the branch it was given) and ADR-047
(conversation history).

## Context

The operator's register item 5 asked for code changes to work in the Chat/Change
flow of the project. The `change` flow already did: plan, approve, implement,
validate, commit, push. A `chat` write was reviewable and not landable - the
model could write a file, with the `chat_edit` approval, the diff was computed
and retained on the task, and then the workspace was destroyed with **no commit
and no push**. The change the person approved survived only as a patch on the
task.

The register posed this as a decision: let an approved chat write continue into
the normal commit/push path, or keep chat read-only and add a "turn this into a
change task" action. The operator has since asked for the first: a code change
made in chat should land.

## Decision

### 1. An approved write goes straight to committing

`implementChat`, after retaining the diff, transitions the task
`implementing -> committing` when the run wrote something (ADR-053 adds that
edge to the state machine; a conversation has nothing to validate, so the
`testing` hop remains only for a chat that answered and changed nothing).

Everything after that point is the **existing** commit/push machinery, not a
copy of it: `commit()` creates the commit with the task-referenced message, and
the push follows the environment's own posture - the `git_push` approval when
one is required, the `GIT_AUTO_PUSH_ON_TASK` auto-approval for development and
staging targets, the no-remote and push-disabled completions. A chat write is
therefore pushed under exactly the rules a change task's commit is.

### 2. The platform still commits and pushes - never the model

The model is told it does not commit or push itself; the platform does, after a
person approved the write. The tools stay unavailable to the model
(`availableToModel: false`), so the earlier design property - a model cannot
commit before its work was reviewed - is unchanged. What changed is who acts on
the approval: the platform, where before nobody did.

### 3. Main is still never worked on directly

`main` keeps a branch of its own for clone-backed tasks (ADR-046), so the
commit lands on that branch, not on `main`. The one case where the working tree
*is* `main` is on-premise operating in place; there an approved chat write is
retained as a diff and not committed, narrated with the way to land it (a change
task against a development or staging environment). ADR-021/ADR-028 hold.

### 4. A workspace with no clone has no diff to retain

The diff is now computed only for a workspace that has one. Before this, a chat
on an `odoo_online` instance or on an `ai_project` without a repository ran
`git diff` in a directory no clone ever existed in - failing the task after the
model had been paid for, for a diff that could not be non-empty. Such a chat
completes as answered-only, which is what ADR-029 always said a chat is.

### 5. The `chat_edit` approval is unchanged in what it authorises

It authorises the write. The landing follows the write's own rules - a chat is
not a second, quieter approval path for a push. A task whose environment needs a
push approval still asks for one.

## What is deliberately not done

- A chat write is not validated (a conversation has no plan and no changed-module
  set to validate against). The write was individually approved; validation
  remains a change-task step.
- There is no "turn into a change task" action; with writes landing, it would be
  a second way to do the same thing.
- A chat cannot target production and cannot push to `main` directly - the same
  refusals as every other kind.

## Consequences

- A conversational change can land, which is the behaviour the operator asked
  for; the diff remains on the task either way.
- The state machine gains one edge (`implementing -> committing`), recorded in
  `task-state.ts` beside ADR-029's `analyzing -> implementing`.
- `agent-workflow.spec` coverage is via the state-machine spec; the loop itself
  is exercised by the chat smoke path.
