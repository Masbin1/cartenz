# ADR-046: A task works on the branch a person chose, not on a branch of its own

- Status: Accepted
- Date: 16 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Builds on ADR-013 (simulated workspaces), ADR-019 (real repository operations),
ADR-021 (push safety and environments), ADR-028 (execution modes) and ADR-038
(staging and development branches). Supersedes the task-branch part of ADR-013.

## Context

Every clone-backed task cloned the repository at the environment's branch and
then cut a branch of its own — `ai/task_<reference>-<description>` — and the
commit and push went there. The branch a person had *chosen* was therefore never
the branch that changed; the change only reached it after somebody merged the AI
branch by hand and deleted it. On-premise already worked the other way: it
commits directly on the environment's branch, in the directory a person selected.

The operator asked for the clone-backed behaviour to go:

> *"kita kan udah milih branch ya pada saat mau promting, tapi pada saat task di
> eksekusi kenapa bikin branch baru lagi? kayanya kita ga perlu bikin branch baru
> lagi deh"* — and *"langsung eksekusi di branch yang udah di pilih aja, bahkan
> kalo emg mau ngepush ya langsung push ke branch itu aja, tanpa bikin branch baru"*

## Decision

### 1. The environment's branch is the task's branch

The workspace clones the environment's branch (as before) and stops there — the
checked-out branch is the branch the work lands on. No separate AI branch is
created for the task.

### 2. `main` keeps a branch of its own

`main` remains the one branch a task never works on directly (ADR-028: the
platform never pushes to `main`; the task-creation refusal in ADR-021 already
keeps change tasks off it). A task whose target resolves to `main` — a `chat`
task on an Odoo.sh project, for instance — still gets an `ai/task_...` branch,
and the branch-name builder stays for exactly that case.

### 3. The push follows the branch

The push step already pushes the workspace's branch to the same name on the
remote, so it now pushes the environment's branch itself. The automatic push for
`development` and `staging` targets (GIT_AUTO_PUSH_ON_TASK) and the production
refusal are untouched: the safety envelope does not change, only where the
commit lands.

## Consequences

- A change requested against `staging` is on `staging` when the task finishes.
  No merge, no delete-the-AI-branch chore, no branch litter in the repository.
- The diff view, the task record and the narration name the environment's
  branch; nothing else about them changes.
- A non-fast-forward push is still refused by git; the commit then stays in the
  workspace and the task says so.
- Projects whose only branch is `main` are unaffected: change tasks there were
  already refused before this decision.

## Verification

- Unit: `taskBranchFor` returns the environment's branch for any branch but
  `main`, and an AI branch name for `main`.
- End-to-end: a `change` task submitted against a `staging` environment commits
  on `staging` in its workspace and — with GIT_AUTO_PUSH_ON_TASK=true — the
  remote's `staging` carries the commit afterwards.
