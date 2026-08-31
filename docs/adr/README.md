# Architecture Decision Records

ADR-001 to ADR-010 are the approved product decisions recorded in
`docs/reference/LinkedERP_AIDevAgent_FrameworkSelection_v1.0_2026-08-27_1.docx`. They are not
restated here; that document is authoritative.

ADR-011 onward are implementation decisions taken by the engineering team while building the
platform. Each records a deviation from, or a clarification of, the approved architecture, together
with the condition under which it is retired.

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-011](ADR-011-orchestration-abstraction.md) | Orchestration abstraction, Temporal deferred | Accepted |
| [ADR-012](ADR-012-local-runtime-without-docker.md) | Local runtime without Docker | Accepted |
| [ADR-013](ADR-013-simulated-workspace-execution.md) | Simulated workspace execution | Accepted |
| [ADR-014](ADR-014-secrets-provider-abstraction.md) | Secrets provider abstraction, Vault deferred | Accepted |
| [ADR-015](ADR-015-first-party-authentication.md) | First-party JWT authentication | Accepted |
| [ADR-016](ADR-016-agent-code-location.md) | Location of agent code | Accepted |
| [ADR-017](ADR-017-project-type-enumeration.md) | Project type enumeration | Accepted |
| [ADR-018](ADR-018-task-status-enumeration.md) | Task status enumeration | Accepted |
| [ADR-019](ADR-019-real-repository-operations.md) | Real repository operations ahead of microVM isolation | Accepted |
| [ADR-020](ADR-020-ai-provider-boundary.md) | Model provider binding and the AI data boundary | Accepted |
| [ADR-021](ADR-021-push-safety-and-environments.md) | Push safety, target environments, and SSH remotes | Accepted |
