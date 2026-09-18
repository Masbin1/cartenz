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
| [ADR-022](ADR-022-tool-output-fidelity-and-targeted-edits.md) | Tool output fidelity and targeted edits | Accepted |
| [ADR-023](ADR-023-portal-managed-model-provider.md) | Portal-managed model provider | Accepted |
| [ADR-024](ADR-024-project-removal.md) | Project removal | Accepted |
| [ADR-025](ADR-025-model-aware-file-selection.md) | Model-aware file selection | Accepted |
| [ADR-026](ADR-026-on-premise-deployment.md) | On-premise deployment | Accepted |
| [ADR-027](ADR-027-odoo-validation-runtime.md) | Running Odoo for validation | Accepted |
| [ADR-028](ADR-028-execution-adapters.md) | Three execution modes behind separate adapters | Accepted |
| [ADR-029](ADR-029-conversational-agent-mode.md) | Conversational agent mode | Accepted |
| [ADR-030](ADR-030-document-ingestion.md) | Document ingestion | Accepted |
| [ADR-031](ADR-031-odoo-source-reference.md) | Odoo source reference | Accepted |
| [ADR-032](ADR-032-odoo-project-scaffolding.md) | Odoo project scaffolding | Accepted |
| [ADR-033](ADR-033-odoo-settings-and-addons-layout.md) | Odoo settings and addons layout | Accepted |
| [ADR-034](ADR-034-project-ready-to-run.md) | A new project is ready to run | Accepted |
| [ADR-035](ADR-035-project-runnable-dev-server.md) | A scaffolded project runs as a local dev server | Accepted |
| [ADR-036](ADR-036-ai-project-scaffolded-and-runnable.md) | A Create-with-AI project is scaffolded locally and runs on-premise | Accepted |
| [ADR-037](ADR-037-odoo-edition-per-project.md) | Odoo edition (Community or Enterprise) is chosen per project | Accepted |
| [ADR-038](ADR-038-scaffold-staging-development-branches.md) | A scaffolded project is created with staging and development branches | Accepted |
| [ADR-039](ADR-039-provisioned-odoo-instance.md) | A created project is a running Odoo instance, provisioned by the operator's scripts | Accepted |
| [ADR-040](ADR-040-provisioned-instance-https-and-credentials.md) | A provisioned instance gets HTTPS, and its master password is sealed | Accepted |
| [ADR-041](ADR-041-created-project-github-repository.md) | A created project gets a GitHub repository, and its pushes land in it | Accepted |
| [ADR-042](ADR-042-image-attachments-vision.md) | Image attachments — paste a screenshot or mock-up and have the agent see it | Accepted |
| [ADR-043](ADR-043-per-project-access-control.md) | Per-project access control | Accepted |
| [ADR-044](ADR-044-region-scoped-deployment.md) | One deployment, region-scoped — the organisation is gone | Accepted |
| [ADR-045](ADR-045-centralized-odoo-versions-and-template-databases.md) | Centralized Odoo version repositories and template-database provisioning | Accepted |
| [ADR-046](ADR-046-tasks-work-on-the-chosen-branch.md) | A task works on the branch a person chose, not a branch of its own | Accepted |
| [ADR-047](ADR-047-workspace-history-lists-conversations.md) | The workspace history lists conversations, not requests | Accepted |
| [ADR-048](ADR-048-single-staged-installer.md) | One staged installer for the whole estate, replacing three overlapping scripts | Accepted |
| [ADR-049](ADR-049-on-premise-instance-pulls-its-repository.md) | An instance pulls its own repository (the odoo.sh half ADR-041 left out) | Accepted |
| [ADR-050](ADR-050-repo-backed-connected-projects.md) | Repo-backed connected projects, and the remote deploy target | Accepted |
| [ADR-051](ADR-051-standard-database-catalog.md) | A standard-database catalog for AI-safe instances | Accepted |
| [ADR-052](ADR-052-ephemeral-preview-instances.md) | Ephemeral preview instances — see the draft Odoo UI before approving | Accepted |
| [ADR-053](ADR-053-approved-chat-write-lands.md) | An approved chat write lands — committed and pushed like a change task | Accepted |
| [ADR-054](ADR-054-per-client-backups.md) | Per-client backups, and the restore point before a staging push | Accepted |
| [ADR-055](ADR-055-per-project-on-host-models-only.md) | A per-project "on-host models only" flag | Accepted |
| [ADR-056](ADR-056-module-selection-at-project-creation.md) | Module selection at project creation | Accepted |
| [ADR-057](ADR-057-merge-to-main-and-project-restart.md) | Merge staging into main, and restart the running instance | Accepted |
