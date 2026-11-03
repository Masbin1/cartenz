# ADR-091: Odoo Online tasks resolve the target model from conversation history

- Status: Accepted
- Date: 3 November 2026
- Milestone: Phase 5 (connected-server estate)

## Context

task_819929: a person asked, across two tasks in the same conversation, for
a project's custom models, then "ya bikinkan sample datanya dong" ("yes,
make the sample data then"). The first task answered correctly, listing
`x_nota_pk` among roughly twenty custom (`x_...`) models. The second task,
which should have inserted ten `x_nota_pk` records, instead read the fields
of `res.config.settings` and refused to write anything, reporting: "the
available tools do not include the ability to write a Server Action" — a
non-sequitur, since nothing about Server Actions was asked; it was reasoning
about the wrong model entirely.

Root cause: `analyzeOdooOnline` and `planOdooOnline`
(`agent-workflow.ts`) both called `inferOdooTarget(snapshot.prompt).model`
to decide which model to read fields from before any planning happened.
`inferOdooTarget` (`odoo-target.ts`) is a small keyword table mapping prompt
vocabulary to Odoo's own standard models ("sales order" → `sale.order`,
"invoice" → `account.move", ...). It has no entry for a project's own
custom models — it cannot, since those are created per-project — and it
only ever reads the current task's prompt, never the conversation that
came before it. "Ya bikinkan sample datanya dong" names no model at all, so
it fell through to `inferOdooTarget`'s hard-coded fallback: `res.config.settings`.
The plan was then built against that model's fields, which have nothing to
do with the request, and the model concluded (correctly, given what it had
been shown) that it could not carry out the plan.

This is the same shape of bug as ADR-090's prompt-staleness issue (the model
told the truth about what it had, the thing it had been given was wrong),
but the broken input this time is the *target model selection*, not the
system prompt's description of a tool.

## Decision

Added `resolveOdooTarget(prompt, history)` in `odoo-target.ts`, used by both
`analyzeOdooOnline` and `planOdooOnline` in place of the bare
`inferOdooTarget(snapshot.prompt)` call. It is additive, not a replacement:
`inferOdooTarget` is unchanged and still used as-is by the repository-based
code path, which has no equivalent concept of a project's own custom model
names.

`resolveOdooTarget` priority, most specific first:

1. A custom (`x_...`) model named in the *current* prompt — matched by
   Odoo's own technical-name pattern (`x_[a-z][a-z0-9_]*`, ADR-068), not a
   keyword table, since a project's custom models cannot be enumerated in
   advance.
2. A standard model `inferOdooTarget` matches in the current prompt — a
   prompt that explicitly pivots ("now add a field to the Sales Order")
   must win over a custom name mentioned several turns ago.
3. The custom model discussed *most* across the conversation's earlier
   turns, a later turn breaking a tie. Deliberately frequency, not "the
   textually last `x_...` name to appear": a model-listing answer names many
   custom models in no particular order of relevance to what comes next: in
   task_819929's own history, the textually-last name was one of several QC
   worksheet templates, not `x_nota_pk`, which appeared twice — once in the
   list, once in the sentence confirming it ("Jadi model x_nota_pk memang
   ada dan benar.").
4. `inferOdooTarget`'s existing `res.config.settings` fallback, unchanged.

`history` is supplied by a new `AgentWorkflow.conversationTurnTexts`, which
reuses the existing `TaskRepository.loadConversationTurns` (ADR-074) but
returns raw prompt/answer text for pattern scanning, rather than the
model-formatted `PromptPart[]` `conversationContext` already builds for the
model's own context window. Same failure rule as that existing method: a
read error degrades to "no history" and falls back to `inferOdooTarget`'s
prior behaviour — conversation history is a convenience for resolving which
model is meant, never a precondition for running the task at all.

## Consequences

- A follow-up request that does not repeat a custom model's name by itself
  now resolves correctly, as long as that model was named earlier in the
  same conversation.
- The repository-based (odoo.sh / on-premise) path is untouched:
  `inferOdooTarget(snapshot.prompt)` is still called directly where a
  project's custom models are not a distinct concept from any other model
  named in a commit's source files.
- This narrows, but does not close, the broader class of bug: a prompt that
  introduces a *brand-new* custom model by name, in the same turn that also
  asks to populate it with data, still depends on `inferOdooTarget`'s
  pattern matching the name correctly on the first prompt — which it does,
  since rule 1 matches the current prompt before anything else runs.
- Tests: `odoo-target.spec.ts` gained 15 new/updated cases for
  `customModelNamesIn` and `resolveOdooTarget`, including the task_819929
  scenario verbatim (a model-listing history, then a bare "bikinkan
  sample datanya dong" follow-up) and the tie-break-by-recency and
  current-prompt-standard-model-wins cases that a first, simpler
  "last mention wins" implementation got wrong before this was corrected.
