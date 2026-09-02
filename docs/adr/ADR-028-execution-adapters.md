# ADR-028 — Three execution modes behind separate adapters

**Status:** Accepted · **Date:** 1 September 2026 · **Milestone:** Phase 5 · **Amends:** ADR-019, ADR-021, ADR-026

## Context

The platform has been built on one execution model: clone a repository into an isolated
per-task workspace, let the agent modify the clone, commit there, and discard the workspace
with the run (ADR-019, ADR-013). Validation and push are simulated (ADR-019, ADR-021).

That single model fits only one of the three project categories the product actually serves.
Cartenz supports exactly three execution modes, and two of them do not look like "clone into
a Cartenz workspace":

| Mode | AI operates on | Git | Push |
| --- | --- | --- | --- |
| `odoo_online` | Odoo instance through Studio | No | No |
| `odoo_sh` | Custom-module Git workspace | Yes | Yes |
| `on_premise` | Directly on the selected local custom-module directory | Yes | Yes |

- **Odoo Online** gives no filesystem or code access. Customization happens through Odoo
  Studio, driven with the project's credentials (URL, API key, username, password). The change
  must be a real change on the instance — not instructions handed back to the user. The Studio
  interaction must follow the mechanism already proven to work with a model against Odoo Online;
  assuming XML-RPC alone would be wrong.
- **Odoo SH** is a Git-based custom-module project. Cartenz prepares an isolated Git workspace
  for the repository, the agent modifies it on a selected branch, and commits and pushes to that
  branch. Modifications are allowed only on branches other than `main`; if the repository has
  only `main`, no customization request is accepted until an administrator creates another branch.
- **On-Premise** already has a complete Odoo environment locally — Odoo base, enterprise, custom
  modules, configuration, database. The selected custom-module directory is already a Git
  repository (typically connected to GitHub). Cartenz does **not** clone it into another
  workspace; the agent operates directly on the selected local directory.

ADR-017 enumerated the five project types but did not decide how each executes. This ADR does.

## Decision

Each execution mode is implemented by its own adapter behind one common interface, so that a
task's mode is decided once, at dispatch, and no tool can reach the wrong kind of resource.

```python
OdooOnlineExecutor   # Odoo instance / Studio, no filesystem access
OdooSHExecutor       # Cartenz-managed Git workspace, branch != main
OnPremiseExecutor    # direct access to the selected local directory, path-contained
```

### OdooOnlineExecutor

- Authenticates against the Odoo Online project with its sealed credentials.
- Performs the requested customization through Studio's proven interaction mechanism. XML-RPC is
  not assumed to be sufficient; the mechanism is the one a model has already been shown to drive
  against Odoo Online.
- Has no filesystem access of any kind. A filesystem tool aimed at an `odoo_online` task is a
  denial, not a no-op.
- Git is not involved.

### OdooSHExecutor

- Prepares an isolated Git workspace for the custom-module repository.
- Enforces the branch restriction in the execution layer: a task may target only a non-`main`
  branch. If the repository contains only `main`, the task is refused before any row is written,
  and the refusal is audited.
- Runs the agent against the workspace, then tests, produces a real diff, commits, and pushes to
  the selected branch. The platform never pushes to `main`.
- SSH authentication is handled by the platform. Private keys are sealed, never appear in a
  prompt, an argument vector, an execution log or model context.

### OnPremiseExecutor

- Operates directly on the selected local custom-module directory; no clone into a per-task
  workspace.
- Enforces path containment in the execution layer, strictly to the selected project directory.
  Odoo base and enterprise may be read — dependency analysis, model inspection, testing — but any
  create, update or delete outside the project directory is refused.
- Git operations run against the selected custom project repository only. Odoo base and
  enterprise are never committed or pushed.

### The AI is never the security boundary

A model cannot be trusted to obey "do not modify Odoo Enterprise." Every chain passes through the
execution layer:

```
AI → Cartenz Tool → Path Permission Validator → Filesystem Operation        (on_premise)
AI → Cartenz Git Tool → Repository Validator → Branch Validator → Git Op    (odoo_sh)
AI → Git Tool → Branch Validator → Reject if branch == main → Git Operation (odoo_sh push)
```

## Consequences

- A task's execution mode is a first-class fact, decided at dispatch from the project type, and
  the tool registry is extended so every tool declares which modes it is legal in. A tool that is
  illegal in the current mode is a denial, tested as such.
- On-premise execution changes the platform's relationship with the workspace: the containment
  root is the selected project directory, not a Cartenz-owned clone. The existing path-containment
  chokepoint (ADR-019 §2) is reused with a configurable root rather than duplicated. This supersedes
  ADR-026 §4, which had on-premise read a working copy by cloning it; the untracked files that clone
  excluded are now visible to the agent's file tools, and the AI data boundary remains the control
  that stops any credential among them from leaving the platform.
- Real push becomes required for `odoo_sh` and `on_premise`, retiring the Phase 3 simulation for
  those modes (amends ADR-019 §Decision and ADR-021). The existing approval gate for push is
  retained.
- Odoo Online introduces the platform's first mode with no repository, no workspace and no Git.
  It exercises the adapter interface rather than the workspace machinery.

## Retirement condition

The adapter interface is not a stopgap; it is the model of the product. It is retired only when
the product supports a fourth execution mode, which would mean extending the interface and
adding an adapter, not replacing this decision.
