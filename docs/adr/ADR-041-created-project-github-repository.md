# ADR-041: A created project gets a GitHub repository, and its pushes land in it

- Status: Accepted
- Date: 12 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Builds on ADR-039 (the repository of a provisioned project is its `addons/`), ADR-028
(execution modes), ADR-021 (push safety) and ADR-036/038 (a created project is a
scaffolded git repository with a branch per environment).

## Context

The platform can create a project and cannot put it anywhere. A project created
through "Create with AI" is scaffolded **on this host**: a directory, a one-commit git
repository, a `staging` and a `development` branch — and no remote. Nothing about it
exists anywhere else, so:

- `GIT_PUSH_ENABLED=true` changed nothing for such a project. The push gate was open
  and there was still nowhere to push: no `origin`, and no repository at the other end
  of one.
- The operator's report was exactly that: *"cartenz punya feature untuk create project,
  tapi ga langsung ngepush ke github."* The feature was not broken; half of it did not
  exist.
- A second defect surfaced at the same time and made even local work fail: the project
  row recorded `onPremisePath` as the project **directory**, while the repository of a
  provisioned project is its `addons/` (ADR-039). The workspace layer required `.git`
  at the recorded path, so every task on every provisioned project died at allocation
  with *"The selected project directory is not a Git repository"* — a message that
  sends a person looking at their project rather than at a stale record.

A note on the missing half: the push machinery was complete and gated
(`GitService.push`, the `git_push` tool, the `git_push` approval, the process-layer
refusal in `CommandRunner`), and `project_connections` already existed as the place a
push reads a credential from. What was missing was the part that makes a repository to
push *into*, and the part that opens the approval for routine work.

## Decision

### 1. Creating a project also creates its repository

When `GITHUB_REPOSITORY_ENABLED=true` with `GITHUB_TOKEN` and `GITHUB_OWNER`, project
creation (both the Create-with-AI flow and the scaffolded `on_premise`/`ai_project`
flow) additionally:

1. creates the repository under `GITHUB_OWNER` — private unless the deployment set
   `GITHUB_REPOSITORY_VISIBILITY=public` — or adopts it if that name already exists;
2. points the project's repository at it as `origin`, with a URL that carries no
   credential;
3. seals `GITHUB_TOKEN` through the secrets store against the project and records it
   as the project's `github` connection, which is where a task's push reads its
   credential from;
4. pushes the default branch and every branch the project has.

The repository name is the project's directory name: already constrained to what git
and GitHub both accept, and a second naming scheme would be one more thing to explain.

**Adopting rather than conflicting** is deliberate. Project creation is retried after a
failure, and a retry that failed on the repository its own first attempt created would
be a failure of the platform's making.

### 2. A failure here does not fail the project

The GitHub step runs *after* the project row, its specification, its environments and
its directory exist — and, for a provisioned project, after a real Odoo instance with a
database, a systemd unit and an Nginx site exist. Throwing at that point would report a
working project as a failed request and invite a retry that collides with the directory
that is already there. So a failure is logged, audited
(`project.github_repository_failed`) and reported in the creation response, and the
project stands.

The response carries the outcome, so a person who expected a remote is told rather than
left to discover its absence from the repository list.

### 3. The credential a task uses is filtered to Git connections

`task-repository` used to take "the first connection holding a secret". That stops
being an answer the moment a project holds two: a project with an Odoo Online API key
(`odoo_api`) and a GitHub connection would have presented the API key to GitHub. The
lookup is now restricted to `GIT_CONNECTION_TYPES` (`github`, `gitlab`, `odoo_sh`),
oldest first, so a project with one Git connection behaves exactly as before.

### 4. `GIT_AUTO_PUSH_ON_TASK` pushes non-production work without an approval

The `git_push` approval exists so that nothing leaves the platform unasked (ADR-021).
With `GIT_PUSH_ENABLED=true` **and** `GIT_AUTO_PUSH_ON_TASK=true`, a task whose target
environment is `development` or `staging` pushes as soon as it commits instead of
parking in `waiting_approval`.

The gate is not removed, it is moved: the deployment asks once, in configuration, and
the scope of that permission is the two non-production environments. `production`
cannot be reached this way because it cannot be targeted at all — `resolveTarget`
refuses it at task creation, before this point in the lifecycle exists. A task with no
resolved environment keeps the approval: when the platform does not know what it is
pushing to, the narrower behaviour is the default. Each auto-approved push writes
`task.push_auto_approved` to the audit trail, so "who authorised this" has an answer
beyond the configuration file it came from.

Repository-backed projects (`repository`, `odoo_sh`) are unchanged: their remote comes
from the connection a person configured, and nothing here creates one.

## Consequences

- A created project is backed by a repository. A task's commit lands on GitHub on
  `development` (or `staging`), and its branches exist remotely from the first push.
- **The repository is a connection, not a `projects.repository_url`** — and anything
  that asks "does this project have a repository?" has to ask both. Leaving
  `repository_url` null for a created project is deliberate (the connection is what
  carries the credential), but the task-submission guard read only `repository_url`
  and therefore refused every development request on exactly the projects creation had
  just given a repository to, with "has no repository yet. Connect one before
  submitting a development request" — naming an action the person had no reason to
  take. The guard now treats a project holding a Git connection as having a
  repository. The lesson generalises: when a new flow records a fact somewhere new,
  audit the readers of the old location rather than only the writer.
- The token lives in two places with different lifetimes, and both are deliberate: the
  deployment's `GITHUB_TOKEN` creates repositories, and a per-project sealed copy is
  what a task's push presents. The push path therefore has one shape — read
  `credentialRef`, unseal it at the moment of use — rather than a second one for
  platform-created projects.
- A deployment without the GitHub settings behaves exactly as before, apart from the
  `onPremisePath` fix, which is a bug fix and not an option.
- `GIT_AUTO_PUSH_ON_TASK` widens what leaves the platform without a per-task click, and
  it is an operator decision for that reason. It is inert while `GIT_PUSH_ENABLED=false`.
- Projects created before this exists have no remote. `npm run github:backfill` (in
  `backend/`) walks them and does what creation now does, idempotently, with
  `--dry-run` to see the plan first.

## Verification

Unit:

- `github-client.spec.ts`: adopts an existing repository instead of creating a second;
  creates under `/orgs/{owner}/repos` for an organisation and `/user/repos` for a user
  account; refuses a repository that came back under a different owner than the
  configured one; sends the token as a header and never in a URL; surfaces GitHub's own
  message on a refused token; refuses an unusable name without calling the API; reports
  itself unavailable when the switch, token or owner is missing.
- `git-remote.spec.ts` (real git, real repositories): a repository with no `origin` is
  given one that a commit then reaches; an existing `origin` is replaced rather than
  failing; a URL carrying an embedded credential is refused and nothing is written.
- `workspace-manager.spec.ts`: a selected directory whose `addons/` is the repository is
  accepted, and the workspace's `repositoryPath` is that `addons/` directory.
- `tasks.service.spec.ts`: a development request on an `ai_project` whose repository is
  a `github` connection is permitted, one whose repository is a `repository_url` is
  permitted, one with neither is still refused, and a `chat` task with neither is still
  permitted.

End-to-end (to be recorded once exercised on a host with a token): a project created
through `POST /projects/ai` appears in GitHub, its `main`, `staging` and `development`
branches exist there, and a task on it completes with `pushed: true` and no approval
step. Evidence is the remote branch list and the task's transition history, not the
diff.
