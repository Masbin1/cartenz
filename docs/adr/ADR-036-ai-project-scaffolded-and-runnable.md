# ADR-036: A Create-with-AI project is scaffolded locally and runs on-premise

- Status: Accepted
- Date: 08 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Amends ADR-017 (`ai_project` type), ADR-028 (execution modes) and ADR-032/033
(scaffolding). Builds on ADR-034 (a created project is runnable) and ADR-035
(a scaffolded project ships a dev-server launcher).

## Context

A project created through the "Create with AI" flow (`createAiProject`) records
a project row, a default environment and a specification — and nothing on disk.
Its `project_type` is `ai_project`, which ADR-028 maps to **no execution mode**,
on the original reasoning that such a project "has no repository and no execution
surface: a task on it can only plan, never modify anything".

That reasoning no longer holds. ADR-032/033 gave the platform a place to put an
on-premise project's code — `<projects_root>/<name>/addons/` — and ADR-034/035
made such a directory installable and runnable. An AI project has `Repository:
None` precisely because its code is meant to live locally, in exactly that
directory. So a Create-with-AI project has every reason to be scaffolded and run,
and two defects stood in the way:

1. **No directory was created.** `createAiProject` never calls the scaffolding
   that `create` performs, so the user sees an empty `projects_root` and a
   project that points at nothing. This is the symptom the user reported:
   *"di folder project masih kosong."*

2. **Even with a directory, tasks would not use it.** `executionModeFor` keys
   only on `project_type`, so an `ai_project` resolves to a simulated,
   throwaway workspace. The agent would plan but never write a module into the
   project's `addons/`, leaving the directory empty of code — the same confusion
   one layer deeper.

Fixing only the first leaves the second: a folder that never fills.

## Decision

1. **Create-with-AI scaffolds a local project directory.** `createAiProject`
   calls the same scaffolding as `create` (an empty `addons/`, the ADR-035
   `odoo.conf`/`run.sh` when the base holds `odoo-bin`, a one-commit git repo),
   and records the repository root as `environmentConfig.onPremisePath`. The
   scaffold guard, previously `on_premise`-only, now also accepts `ai_project`;
   repository-backed types are still refused because their code comes from the
   repository they connect to.

2. **A scaffolded AI project executes on-premise.** `executionModeFor` gains an
   option `hasLocalDirectory`. An `ai_project` with a local directory resolves to
   the `on_premise` execution mode; without one it stays `null` as before. The
   task layer already reads `onPremiseProjectPath` from the same
   `environmentConfig` beside where it derives the mode, so the signal is threaded
   from data that already exists — no new column.

3. **Scaffolding remains best-effort for the launcher, mandatory for the
   directory.** As in ADR-035 the runnable files are skipped when the base has no
   `odoo-bin`, but the directory and its git repo are not optional: without them
   the project cannot run a task, so a failure to create them fails creation
   (and cleans up the half-written directory, per ADR-032).

## Consequences

- A Create-with-AI project now appears at `<projects_root>/<name>/`, runs with
  `./run.sh`, and its tasks write real modules into `addons/` and validate them
  (ADR-034) — the same guarantees an on-premise project already had.
- `ai_project` becomes a *creation flow*, not a permanently inert type. The type
  still exists (it carries the AI specification), but its execution is decided by
  whether it has a local directory, not by the type alone.
- An older `ai_project` created before this change has no `onPremisePath`, so it
  keeps resolving to `null` (plan-only) — unchanged, not retroactively broken.
  Making it runnable is a separate, explicit backfill.
- The single decision point for execution mode is preserved: it is still
  `executionModeFor`, now given one more fact rather than duplicated elsewhere.

## Verification

- Unit: `executionModeFor('ai_project', { hasLocalDirectory: true })` is
  `on_premise`; with `false`/omitted it is `null`; the other four types are
  unchanged. The scaffold guard accepts `ai_project` and still refuses
  `repository`/`odoo_sh`.
- End-to-end (dev box): a project created through `POST /projects/ai` produces a
  directory under the configured projects root containing `addons/`, `run.sh` and
  `odoo.conf`, on a one-commit git repo; the project's task execution mode
  resolves to `on_premise`. Evidence is the directory listing and the resolved
  mode, not the diff.
