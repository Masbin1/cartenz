# Architecture Decision Records

ADR-001 to ADR-010 are the approved product decisions recorded in
`docs/reference/LinkedERP_AIDevAgent_FrameworkSelection_v1.0_2026-08-27_1.docx`. They are not
restated here; that document is authoritative.

ADR-011 onward are implementation decisions taken by the engineering team while building the
platform. Each records a deviation from, or a clarification of, the approved architecture, together
with the condition under which it is retired.

## How this index is organised

The estate serves three hosting modes — Odoo Online, Odoo.sh and on-premise — and most decisions are
not about any one of them. An ADR is listed under a hosting mode only when the decision exists
*because* that mode exists; everything that governs every mode sits under **Platform**. That is why
the three hosting groups are short: they hold the mode-specific differences, not the whole
architecture.

A new ADR goes in the group matching the mode it changes; when in doubt, it is a Platform decision.

## Platform — decisions that govern every hosting mode

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-011](ADR-011-orchestration-abstraction.md) | Orchestration abstraction, with Temporal deferred | Accepted |
| [ADR-012](ADR-012-local-runtime-without-docker.md) | Local runtime without Docker | Accepted |
| [ADR-013](ADR-013-simulated-workspace-execution.md) | Simulated workspace execution | Accepted |
| [ADR-014](ADR-014-secrets-provider-abstraction.md) | Secrets provider abstraction, with Vault deferred | Accepted |
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
| [ADR-027](ADR-027-odoo-validation-runtime.md) | Running Odoo for validation | Accepted |
| [ADR-028](ADR-028-execution-adapters.md) | Three execution modes behind separate adapters | Accepted |
| [ADR-029](ADR-029-conversational-agent-mode.md) | Conversational agent mode with inline write approval | Accepted |
| [ADR-030](ADR-030-document-ingestion.md) | Document ingestion — read a project's PRD and execute tasks from it | Accepted |
| [ADR-031](ADR-031-odoo-source-reference.md) | Odoo source as a read-only reference on every Odoo project | Accepted |
| [ADR-034](ADR-034-project-ready-to-run.md) | A new project is ready to run | Accepted |
| [ADR-037](ADR-037-odoo-edition-per-project.md) | Odoo edition (Community or Enterprise) is chosen per project | Accepted |
| [ADR-038](ADR-038-scaffold-staging-development-branches.md) | A scaffolded project is created with staging and development branches | Accepted |
| [ADR-041](ADR-041-created-project-github-repository.md) | A created project gets a GitHub repository, and its pushes land in it | Accepted |
| [ADR-042](ADR-042-image-attachments-vision.md) | Image attachments — paste a screenshot or mock-up and have the agent see it | Accepted |
| [ADR-043](ADR-043-per-project-access-control.md) | Per-project access control | Accepted |
| [ADR-044](ADR-044-region-scoped-deployment.md) | One deployment, region-scoped — the organisation is gone | Accepted |
| [ADR-046](ADR-046-tasks-work-on-the-chosen-branch.md) | A task works on the branch a person chose, not on a branch of its own | Accepted |
| [ADR-047](ADR-047-workspace-history-lists-conversations.md) | The workspace history lists conversations, not requests | Accepted |
| [ADR-048](ADR-048-single-staged-installer.md) | One staged installer for the whole estate, replacing three overlapping scripts | Accepted |
| [ADR-052](ADR-052-ephemeral-preview-instances.md) | Ephemeral preview instances — see the draft Odoo UI before approving | Accepted |
| [ADR-053](ADR-053-approved-chat-write-lands.md) | An approved chat write lands — committed and pushed like a change task | Accepted |
| [ADR-055](ADR-055-per-project-on-host-models-only.md) | A per-project "on-host models only" flag | Accepted |
| [ADR-060](ADR-060-one-approval-per-push-and-verified-delivery.md) | One approval per push, and a push is not delivered until it is verified | Accepted |
| [ADR-061](ADR-061-calm-content-first-portal-design.md) | A calm, content-first portal design | Accepted |
| [ADR-062](ADR-062-task-pulls-its-branch.md) | A task can pull the branch it works on, and "nothing new" is a success | Accepted |
| [ADR-063](ADR-063-project-local-checkout.md) | A Connected Project Keeps One Local Clone, and Tasks Work From It | Accepted |
| [ADR-065](ADR-065-web-push-notifications.md) | Web push notifications for approval, completion and failure | Accepted |
| [ADR-066](ADR-066-ai-office-read-only-board.md) | AI Office is a read-only board over tasks, not a multi-agent runtime | Accepted |
| [ADR-072](ADR-072-email-invitations-and-password-reset.md) | Email invitations and password reset | Accepted |
| [ADR-074](ADR-074-conversation-remembers-earlier-turns.md) | A conversation remembers its earlier turns | Accepted |
| [ADR-076](ADR-076-delete-project-deletes-github-repository.md) | Deleting a project deletes the GitHub repository it created | Accepted |
| [ADR-080](ADR-080-project-wide-conversation-memory.md) | A request sees the project's other conversations | Accepted |
| [ADR-081](ADR-081-task-settlement-reply.md) | The reply is composed from what the task did | Accepted |

## Odoo Online

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-064](ADR-064-odoo-online-record-writes.md) | Odoo Online records are reachable, gated by permission and approval | Accepted |
| [ADR-068](ADR-068-odoo-online-model-creation.md) | Odoo Online can create a model, as one Studio-shaped sequence | Accepted |
| [ADR-070](ADR-070-odoo-online-assisted-creation.md) | Creating an Odoo Online database is assisted, not automated | Accepted |

## Odoo.sh

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-067](ADR-067-restored-copy-of-connected-project.md) | Restored copy of a connected odoo.sh project | Accepted |
| [ADR-069](ADR-069-connected-project-provisioned-instance.md) | A connected odoo.sh project can provision its own instance | Accepted |
| [ADR-071](ADR-071-odoo-sh-assisted-creation.md) | Creating an Odoo.sh project is assisted, and Cartenz adopts the repository Odoo.sh creates | Accepted |

## On-premise (provisioned and connected estates on the Cartenz host)

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-026](ADR-026-on-premise-deployment.md) | On-premise deployment | Accepted |
| [ADR-032](ADR-032-odoo-project-scaffolding.md) | Scaffolding a custom addon when an Odoo project is created | Accepted |
| [ADR-033](ADR-033-odoo-settings-and-addons-layout.md) | Odoo paths in the portal, and an addons directory per project | Accepted |
| [ADR-035](ADR-035-project-runnable-dev-server.md) | A scaffolded project runs as a local dev server, without Docker | Accepted |
| [ADR-036](ADR-036-ai-project-scaffolded-and-runnable.md) | A Create-with-AI project is scaffolded locally and runs on-premise | Accepted |
| [ADR-039](ADR-039-provisioned-odoo-instance.md) | A created project is a running Odoo instance, provisioned by the operator's own scripts | Accepted |
| [ADR-040](ADR-040-provisioned-instance-https-and-credentials.md) | A provisioned instance gets HTTPS, and its master password is sealed rather than shown | Accepted |
| [ADR-045](ADR-045-centralized-odoo-versions-and-template-databases.md) | Centralized Odoo version repositories and template-database provisioning | Accepted |
| [ADR-049](ADR-049-on-premise-instance-pulls-its-repository.md) | An instance pulls its own repository | Accepted |
| [ADR-050](ADR-050-repo-backed-connected-projects.md) | Repo-backed connected projects, and the remote deploy target | Accepted |
| [ADR-051](ADR-051-standard-database-catalog.md) | A standard-database catalog for AI-safe instances | Accepted |
| [ADR-054](ADR-054-per-client-backups.md) | Per-client backups, and the restore point before a staging push | Accepted |
| [ADR-056](ADR-056-module-selection-at-project-creation.md) | Module selection at project creation | Accepted |
| [ADR-057](ADR-057-merge-to-main-and-project-restart.md) | Merge staging into main, and restart the running instance | Accepted |
| [ADR-073](ADR-073-fit-gap-database-setup-at-project-creation.md) | Fit-gap database setup at project creation | Proposed |
| [ADR-075](ADR-075-on-premise-database-injection.md) | An on-premise project's database is reachable — from the brief and from a prompt | Proposed |
