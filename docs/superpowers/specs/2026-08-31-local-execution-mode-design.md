# Local execution mode — design

**Status:** Draft · **Date:** 2026-08-31 · **Topic:** Odoo.sh + On-premise projects edited, run and pushed directly on the local host

## Context

The platform today runs the agent against a **per-task ephemeral clone**: `WorkspaceManager.allocate`
clones the repository into `task-{ref}-{id}/repository`, the agent edits there, and
`WorkspaceManager.release` deletes the directory when the task settles. `git push` is simulated and
refused (ADR-021), repository code is never executed (ADR-013/019), and on-premise is reached by
cloning a `file://` URL (ADR-026).

The operator's actual use is a single trusted machine. All Odoo projects live under
`/home/masbintang/linkederp`, and the goal is to edit them **in place**, run them to validate, and push
the change. Hermes — the local OpenAI-compatible gateway at `http://127.0.0.1:20128/v1` (ADR-023) — is
the model, not a separate execution service.

Three product decisions were made up front:

1. **Hermes = the LLM gateway.** The platform's worker stays the execution layer; Hermes is wired as a
   model provider only.
2. **Edit directly in the project folder.** Persistent local workspace, not a per-task clone.
3. **Odoo.sh + On-premise first.** Odoo Online (SaaS — no local code, no git, no addons path) stays a
   "coming soon" card; nothing is built for it now.

## Approach

**Extend the existing platform.** Rejected alternative: a standalone "Hermes worker" rebuilt from
scratch — that discards the working agent loop, approval flow, audit trail and the 402-test suite for
no benefit on a single trusted host.

## Design

### 1. Project connection

The project types already exist (`repository`, `odoo_sh`, `on_premise`, `odoo_online`, `ai_project`;
ADR-017). What is added is **where a project lives on this host**, carried as a first-class field
rather than buried in the existing free-form `environmentConfig` JSON, because workspace allocation
reads it:

- `localPath` (nullable string): the project's directory on the host.
- The `projectType` disambiguates what that path means:
  - `on_premise` → `localPath` is the project's **addons directory**, edited in place.
  - `odoo_sh` → `localPath` is the **stable clone directory**; the repository is cloned there once if
    absent, then worked on the AI branch.

Global on-premise layout is configuration, not per-project data, matching "base and enterprise are
already set up": the existing `ODOO_RUNTIMES` and `ODOO_SHARED_ADDON_PATHS` already declare the Odoo
core and the shared addon paths per series (ADR-027). The agent's writable root is the project's
addons directory only; base and enterprise are shared read-only paths and are never written. A new
`ODOO_BASE_PATH` / `ODOO_ENTERPRISE_PATH` pair is **not** added — the runtime configuration that
already exists covers the same ground.

Environments already carry `branch` and `kind` (`production` / `staging` / `development`) and already
refuse `production` as a task target (ADR-021). Odoo.sh reuses this unchanged: a branch maps to a kind.

### 2. Workspace: persistent local strategy

`WorkspaceManager` gains a second strategy alongside the per-task clone. When a project has a
`localPath`, allocation resolves and validates that path once against a configured `projectsRoot`
(default `/home/masbintang/linkederp`), and the workspace `root` **is** that path:

- No clone for `on_premise`; the directory already exists.
- Clone-once for `odoo_sh`: clone into `localPath` only when absent, then create the AI branch.
- `release` does **not** delete a local workspace. It only records the settled status.

Path containment (`workspace-path.ts`) is unchanged — it still enforces `resolve → realpath → inside
root`. Only the root changes, from a per-task clone directory to the project's own directory. This is
the load-bearing boundary and is deliberately not simplified.

### 3. Execution gates & tool surface

- **`git_push` (real).** Pushes the AI branch via `GitService.push`. It never targets a `production`
  environment, and it passes through the existing approval path (`leavesPlatform` → `git_push`
  approval, already mapped in `approvalActionForTool`). Enabled when `GIT_PUSH_ENABLED=true`; the
  process-layer refusal of ADR-021 is what flips.
- **Validation ("run").** Reuses the platform's existing ADR-027 validation infrastructure
  (`OdooValidationRunner`, `VALIDATION_ENABLED=true`, `CommandRunner` python3/odoo-bin allowlist with
  `assertOdooInvocation`). Rather than adding a second execution path or a new `run_odoo` tool, the
  agent's "run" step executes the project's touched modules against the scratch database using the
  project's series Odoo core.

Both capabilities go through the existing `ToolRegistry` / `ToolPermissionValidator` / `CommandRunner`
chokepoints; there is no second execution path.

### 4. Hermes as the model

Already supported: `openai-compatible` is a first-class provider configured at `/settings`
(ADR-023). The only change is a **"Hermes (local)" preset** in the settings UI that points at
`http://127.0.0.1:20128/v1`. No agent-loop code changes.

### 5. Safety kept (not simplified)

- Path containment stays (realpath-inside-root), extended to the project's `localPath`.
- Production remains non-targetable and non-pushable.
- Execution remains behind `VALIDATION_ENABLED` plus the `CommandRunner` closed allowlist.
- `git_push` is real only under `GIT_PUSH_ENABLED` and still passes the approval gate.

## Default to confirm

"Run" means **validate a change**: the `testing` step runs the project's touched modules through the
existing `OdooValidationRunner` — `odoo-bin -u <module> -d <scratch>` against a scratch database that
is dropped afterwards — never a long-running dev server and never the customer's live database. The
project's addons directory is added to the addon path; base and shared addon paths come from the
configured runtime (`ODOO_RUNTIMES` / `ODOO_SHARED_ADDON_PATHS`).

## Out of scope

- Odoo Online (API/Studio integration) — deferred entirely.
- Reading Odoo base/enterprise source for model discovery — the agent's own knowledge of Odoo models
  is sufficient for the first cut; the paths are declared but not yet read.
- The Python connector (Phase 6) — on-premise here is direct local filesystem access on the same host,
  not a remote connector.

## Verification

- Unit: path containment holds with the new root (a `localPath` symlink-out-of-root is refused).
- Unit: `git_push` is real only when `GIT_PUSH_ENABLED=true`; `CommandRunner` still refuses any
  `python3` invocation that is not the configured `odoo-bin` (`probe-validation-refusal.js`).
- Smoke: connect an `on_premise` project at an addons path, submit "add a field to sale.order", and
  assert the file is edited in place with no clone and no workspace deletion afterwards.
- Smoke: an `odoo_sh` project clones once into its stable path and pushes a non-production AI branch
  with `GIT_PUSH_ENABLED=true`.
