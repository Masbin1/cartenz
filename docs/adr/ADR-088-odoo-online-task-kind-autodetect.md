# ADR-088: Task-kind auto-detection on Odoo Online

- Status: Accepted
- Date: 3 November 2026

## Context

Every task names a kind: `change` (plan, approve once, then implement) or
`chat` (answer, asking for approval only when a write tool is actually
reached). The portal asked the person to choose with a two-button toggle
before every request.

On Odoo Online specifically, that toggle was pure overhead rather than a
meaningful safety choice. The two kinds there differ in exactly one thing -
*when* approval is asked:

- `change`: plan first, put the whole plan to a person once, implement only
  once it is approved.
- `chat`: run immediately; a write tool (`odoo_record_write`,
  `odoo_model_create`, ADR-087's `browser_session`) still stops for approval,
  but inline, the moment the model reaches it, rather than as a plan read in
  advance.

Neither skips the validation the other runs, because Odoo Online has none to
skip - there is no repository, no test suite, no `-u module` to run. So a
request that should have been `chat` but was submitted as `change` costs one
unnecessary plan-approval round; a request that should have been `change`
but was submitted as `chat` costs one inline approval appearing mid-run
instead of as a plan up front. Both are a minor difference in *when* a person
is asked, not a difference in *what* is allowed to happen unapproved. That is
what makes guessing safe here.

The same toggle is not overhead on a repository-backed project (odoo.sh,
on-premise, GitHub-connected `ai_project`). There, `chat`'s testing step is
a no-op (`completeChat` in `agent-workflow.ts` transitions straight to
`completed`) while `change` always runs `OdooValidationRunner` - lint, the
Python tests, the Odoo module tests. A misclassification there is not a
difference in timing; it is a difference in whether the change was checked at
all before it reached a branch a person reviews. That is the one case this
ADR deliberately leaves alone.

## Decision

On `odoo_online` projects only, a task submitted with no `kind` is classified
from its own text by a small model call instead of defaulting to `change`.
Every other project type is unaffected: the portal keeps the manual
Change/Chat toggle, and a request with no `kind` there still defaults to
`change`, exactly as before.

### Classification

`TaskKindClassifier` (`backend/src/agent/orchestration/task-kind-classifier.ts`)
asks a `fast: true` provider - this is one word of output standing in for a
button the person didn't click, not a step that should spend the main
chain's slowest, most capable member - for a structured `{ kind: "chat" |
"change" }`, with the instruction to answer `"change"` whenever the request
is ambiguous.

The classifier fails toward `change`, never `chat`, on every error path: a
parse failure, a thrown call, a provider that cannot be resolved. This is
deliberate and asymmetric. A wrong `change` guess costs one plan-approval
round that turned out to describe a question. A wrong `chat` guess reaches a
write tool with no plan a person has seen - still gated by its own approval,
but a worse surprise than the other direction. Failing toward the safer
guess means a classifier outage degrades to "every Odoo Online request plans
first", not to "every Odoo Online request skips the plan".

### Where it hooks in

`TasksService.create` (`backend/src/modules/tasks/tasks.service.ts`) classifies
immediately after loading the project, before any of the existing
repository/permission checks:

```ts
if (dto.kind === undefined && project.projectType === 'odoo_online') {
  kind = await this.taskKindClassifier.classify(dto.prompt, projectId);
}
```

`dto.kind === undefined`, not falsy: the portal omits the field entirely on
Odoo Online now (see below), but the API contract still accepts an explicit
`kind` from any other caller (a script, a future integration) and honours it
without asking the classifier - the auto-detection is a convenience for an
unlabelled request, not a override of a labelled one.

### The portal

`frontend/app/projects/[projectId]/agent/page.tsx` hides the Change/Chat
toggle when `project.projectType === 'odoo_online'`, and omits `kind` from
the request body there instead of sending the button state. Every other
project type is unchanged: the toggle still renders, and the person's choice
is still sent.

## Consequences

- An Odoo Online conversation reads as plain chat: type the request, and the
  platform decides whether it needs a plan. The toggle most people never
  understood the stakes of is gone from the one surface where it carried no
  stakes.
- odoo.sh, on-premise and GitHub-connected projects are unchanged in every
  respect - toggle, default, and behaviour. This ADR narrows its scope to
  Odoo Online specifically because that is the one surface where the two
  kinds are safety-equivalent; extending it elsewhere is a different decision
  with a different risk (skipped validation), not a bigger version of this
  one.
- One additional model call lands on the critical path of every unlabelled
  Odoo Online task. It is deliberately the fast tier, and its failure mode is
  "defaults to change" rather than "the task fails to submit" - a classifier
  outage degrades the experience back to today's always-`change` behaviour,
  it does not block anyone.
- A caller that already sends an explicit `kind` (the portal, for every
  non-Odoo-Online project type; any future direct API caller) is never
  affected: classification only runs when the field is absent.

## Testing

- `task-kind-classifier.spec.ts`: the provider's answer is returned; a
  provider throw defaults to `change`; a `forProject` throw (no chain
  configured) defaults to `change`; the call requests `{ fast: true }`.
- `tasks.service.spec.ts` (`Odoo Online kind auto-detection`): the classifier
  runs for an unlabelled `odoo_online` request and is given the prompt and
  project id; it does not run when the caller already named a kind; it does
  not run for `odoo_sh` or `on_premise`, which keep today's default.
