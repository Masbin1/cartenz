# ADR-017 — Project type enumeration

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 1

## Context

Table 4 of the Technical Architecture defines `project_type` as one of `odoo_sh`, `on_premise` or
`odoo_online`. Chapter 2 states that the MVP focuses on Git-based Odoo projects, in particular those
hosted through Odoo.sh or standard Git repositories, and the product requirement for this build
includes a Create New Project with AI flow that produces a structured project specification before
any repository exists.

Neither a standard Git repository nor a new AI-authored project is representable in the documented
enumeration. Using `odoo_sh` would be inaccurate for a plain GitHub or GitLab repository, since
Odoo.sh implies a specific build and deployment integration that the platform monitors.

## Decision

`project_type` is extended by two values, giving five in total:

| Value | Meaning | Source |
| --- | --- | --- |
| `repository` | A standard Git repository not hosted on Odoo.sh | Extension |
| `odoo_sh` | An Odoo.sh-hosted project, with build monitoring | Architecture Table 4 |
| `on_premise` | Customer-hosted Odoo, reached through the connector | Architecture Table 4 |
| `odoo_online` | Odoo Online, reached through the integration service | Architecture Table 4 |
| `ai_project` | A new project specified through the AI flow, with no repository yet | Extension |

The enumeration is declared once, in `backend/src/core/enums.ts`. `connection_type`, the approval
status and the task-status enumeration are unchanged from Table 4 and are declared in the same file.

The three documented values retain their documented meaning exactly. The extension is additive, so no
record that would have been valid under Table 4 becomes invalid.

## Consequences

Both required product flows are representable without overloading a documented value with a meaning
it does not carry, and behaviour can be dispatched on the type honestly: `odoo_sh` alone triggers
build monitoring, and `ai_project` alone permits a project with no repository reference.

Table 4 of the Technical Architecture should be updated to five values at its next revision. Until
that revision is issued, this ADR is the record of the divergence.
