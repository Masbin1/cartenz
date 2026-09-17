# ADR-050: Repo-backed connected projects, and the remote deploy target

- Status: Accepted
- Date: 17 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-026 (on-premise deployment), ADR-028 (execution modes), ADR-039
(provisioning), ADR-041 (created project gets a repository), ADR-049 (an instance
pulls its own repository) and ADR-051 (standard database catalog).

## Context

A connected (on-premise) project operates **in place** on a local directory of the
host Cartenz runs on (ADR-026, ADR-028). `executionModeFor('on_premise')` is fixed by
the type (`backend/src/agent/executors/execution-mode.ts:32`), and the workspace
manager runs `git checkout` on that directory — it never clones
(`workspace-manager.ts`, `allocateOnPremise`).

That is correct when Cartenz is installed beside the customer's Odoo. It does not
cover the case the operator raised: **the customer's Odoo may be on another server**.
Cartenz cannot see that host's filesystem, and the connect form requires a folder that
already exists under `ON_PREMISE_ROOT` on the Cartenz host. Today a person must clone
the repository by hand, then point Cartenz at the copy.

The operator asked for the odoo.sh shape: pull the repository, replicate the project
on the server Cartenz runs on, and work there.

## Decision

### 1. `on_premise` with a repository is repo-backed

A connected project that has a `repositoryUrl` runs the same per-task clone as
`repository` and `odoo_sh`: a throwaway workspace under `/tmp`, the environment's
branch as the checked-out branch, and a push that targets `development` or `staging`
only (ADR-021, ADR-046). `on_premise` joins `REPOSITORY_BACKED_PROJECT_TYPES`
conditionally — when a repository is recorded — and `executionModeFor` reads the
repository rather than the type alone.

A connected project **without** a repository keeps the in-place behaviour of ADR-026.
That case is real and different — Cartenz installed beside an Odoo whose working copy
may be a checkout of nothing — and requiring a repository would delete it.

### 2. The replica is code + standard database + shared Odoo source

The replica on the Cartenz host is made of three things and **no client data**:

| Part | Source |
| --- | --- |
| Addons code | The project's Git repository, cloned per task |
| Database | LinkedERP's standard database for the version + edition + region (ADR-051) |
| Odoo source | The shared read-only checkout for the project's version (ADR-045) |

This is what makes validation (ADR-027) and the UI preview (the deferred item in
`docs/architecture/client-estate-and-server-architecture.md` §6.8) possible on a host
that is not the customer's.

### 3. The customer's database is never replicated

Cloning the repository copies **code**, not the database, filestore or server config.
The standard database stands in for the client database so the AI never works against
customer data. A client example database is restored by a separate, explicit, manual
action and is never the database a task runs on.

### 4. The deploy target is explicit, and separate from the replica

Two things are named differently and must not be confused:

- **Hosted replica** — a Cartenz-hosted Odoo used for development, preview and
  validation. Its deploy is the local `pull-project.sh` (ADR-049).
- **Customer instance** — the Odoo the customer actually runs, possibly on another
  server. **The customer's host pulls the branch itself** (webhook, CI or a scheduled
  `git pull`). Cartenz's responsibility ends at changing the code and pushing it to
  the customer's GitHub repository; it does not deploy to that host and holds no SSH
  path to it. Privilege stays minimal and no inbound path to Cartenz exists. The
  Phase 6 connector is explicitly **not** used for this.

  This is the settled decision, not a preference: the platform's job is "change and
  push", and making the customer's host the deployment target for its own branch is
  what keeps that boundary clean and the customer's environment independent.

## Consequences

- A person can connect a repository and work on it without first placing a copy on the
  Cartenz host — the gap the operator reported.
- The in-place mode survives for the ADR-026 case, so nothing that works today breaks.
  The behaviour difference is decided by whether a repository is recorded, which is a
  fact the project already carries.
- Customer source code transiently lives on the Cartenz host in the task workspace.
  The existing controls already bound this — workspaces are destroyed on completion
  (`WorkspaceManager.release`), the AI data boundary governs egress to a model, and
  the customer's **data** is never cloned — but it is a real change from the in-place
  posture and is now deliberate rather than incidental.
- The standard database is version- and region-specific, so a replica requires a
  matching artifact; a missing template fails loudly rather than silently producing an
  empty database (ADR-045, ADR-051).
- The project naming must make "replica" and "customer instance" distinct in the
  portal, or a person will read a replica preview as the live system.

## Retirement condition

Retire or revise if the Phase 6 connector makes in-place and remote equivalent, or if
the platform gains a first-class preview-environment concept that makes a per-project
replica redundant.

## Verification

Not yet implemented. When it is, the checks are:

- An `on_premise` project with a `repositoryUrl` allocates a clone workspace and its
  task lands on the chosen branch; one without a repository keeps the in-place path.
- The replica's database is the standard artifact for the project's version, edition
  and region, and its `database.uuid` is fresh.
- A push to `production` is still refused at task creation.
- No client data reaches the replica: the standard database contains none, and a
  client example database is only present after an explicit manual restore.
