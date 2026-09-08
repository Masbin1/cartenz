# ADR-038: A scaffolded project is created with staging and development branches

- Status: Accepted
- Date: 08 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Amends ADR-032 (scaffolding) and ADR-021 (environments). Builds on ADR-036 (an
AI project is scaffolded and runs on-premise).

## Context

A scaffolded project (ADR-032/036) is created as a git repository with a single
branch (`main`) and a single `development` environment pointing at it. A real
Odoo delivery works across at least two lines — a development branch where the
work happens and a staging branch it is promoted to — and ADR-021 already models
an environment as a branch. So the two ideas line up: the project should be
created with a `staging` and a `development` environment, and the git repository
should carry the matching branches so a task targeting either has somewhere to
commit.

Today the person has to create the second environment and branch by hand after
the project exists, which is avoidable: at creation time the platform knows it is
scaffolding a fresh repository and can lay both branches down at once.

## Decision

1. **A scaffolded repository is laid down with three branches.** After the
   initial commit on the default branch (`main`), the scaffold creates a
   `staging` and a `development` branch at that commit. `main` is the base the
   two diverge from; the work happens on `development` and is promoted to
   `staging`.

2. **Two environments are created by default.** When the caller declares no
   environments, a scaffolded project gets `Development` (branch `development`,
   the default target) and `Staging` (branch `staging`, kind `staging`), instead
   of the single `Development`-on-`main` default. A caller that declares its own
   environments is still honoured unchanged, and a branch is created for each
   declared environment so every environment a task can target exists in the
   repository.

3. **Only scaffolded projects.** A repository-backed project (`repository`,
   `odoo_sh`) takes its branches from the remote it connects to, so this applies
   to the scaffolded types only (`on_premise`, `ai_project`). The AI flow, which
   never declares environments, always gets the two.

## Consequences

- A created project is immediately workable on two lines: a task can target
  Development or Staging and each has a real branch to commit to.
- The default target stays Development (never production, per ADR-021), so
  submitting a task without naming an environment behaves as before.
- Branch creation is part of the scaffold's atomic step: if any branch cannot be
  created the whole scaffold is torn down (ADR-032), so a project never points at
  a repository missing a branch its environment names.
- `main` remains the initial branch so the existing single-environment callers
  and every test that expects `main` keep working; the addition is the two
  branches beside it and the second environment.

## Verification

- Unit: the scaffold environment default lists Development-on-`development` and
  Staging-on-`staging`; a declared set is passed through unchanged.
- End-to-end (dev box): a project created through `POST /projects/ai` is a git
  repository whose `git branch` lists `main`, `staging` and `development`, and the
  project has two environments with the matching branches. Evidence is the branch
  list and the environments, not the diff.
