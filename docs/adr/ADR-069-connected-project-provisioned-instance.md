# ADR-069: A connected odoo.sh project can provision its own instance

Status: Accepted (2026-09-29)

Relates to: ADR-039 (a created project is a running instance), ADR-040 (HTTPS
and the sealed master password), ADR-050 (repository-backed connected
projects), ADR-067 (restored copy loaded from an odoo.sh backup).

## Context

ADR-067 gives an operator a way to see a connected odoo.sh project's real
data: download a backup, stage it, and the platform builds a neutralized copy
bound to localhost, for a person to look at. That instance is deliberately
locked (`list_db = False`) and reachable only by SSH tunnel — correct for
real customer data, wrong for the separate, more common ask: "give this
connected project a running Cartenz instance the project owner can reach
directly and load their own database into, the way they would on a fresh
`create_project` — but starting empty rather than from a backup the operator
must first obtain."

The two features solve different problems and are not a spectrum of one
feature: ADR-067's instance holds real customer data and stays locked down;
this one holds no data at all until the project owner puts some there, and is
reachable like any other provisioned project.

## Decision

A connected `odoo_sh` project can have one **provisioned instance**: a NEW,
empty Odoo instance on the Cartenz host, running the project's own declared
version and edition (the same fields `Maha`/`AL3`/`Omnisurge`/`Linkederp`
already carry), with the project's own repository checked out into `addons/`
when one is connected.

- **No new root script.** This reuses the exact chain `create_project`
  (create-with-AI) already runs, invoked from a different trigger:
  1. `sudo create_project_enterprise <name> <port> <version> <region>` (or
     `create_project` for a community project) — directory, database cloned
     from the standard template, systemd unit, Nginx site. `list_db` stays
     `True` in the generated `odoo.conf`, exactly as it is for every AI-created
     project — that is what makes `/web/database/manager` reachable for the
     project owner to restore or duplicate into.
  2. `sudo grant-addons-write.sh <name>` — the same ownership fix-up every
     provisioned project needs before the platform can write into `addons/`.
  3. `sudo pull-project.sh <name> <repositoryUrl> <branch>` — only when the
     project has a connected repository; the credential travels on stdin,
     never argv, exactly as a restart's pull does. Absent a repository, the
     instance starts on the template's own bundled addons only, which is a
     valid state (an operator wires the repository later and reruns the
     existing pull button).
  4. `sudo setup-project-https.sh <name> <name>.<base-domain> <email>` — same
     script and Cmnd_Alias entry ADR-040 already grants; no new sudoers line.
- **New instance name, not the project's own on-premise path.** Mirrors
  ADR-067's `deriveInstanceName`: distinct from any technical name already in
  use (`<slug>-i-<id8>`), because a connected project may already have a
  restored copy (ADR-067) using the "restored" suffix and the two must never
  collide.
- **Columns on `projects`** (migration `0026_connected_instance.sql`),
  mirroring `restored_*`: `connected_instance_status`
  (`none|pending|ready|failed`), `connected_instance_name`,
  `connected_instance_port`, `connected_instance_url`,
  `connected_instance_master_password_ref`, `connected_instance_error`,
  `connected_instance_created_at`. Port allocation checks
  `provisioning_port`, `restored_port` AND `connected_instance_port` together
  — three independent instances can exist on one project row.
- **Async, queued** on the same `PROJECT_PROVISIONING_QUEUE` BullMQ queue
  ADR-056/ADR-057/ADR-067 already share, job name `create-connected-instance`
  (`PROJECT_CONNECTED_INSTANCE_JOB`), job id `connected-instance-<name>` with
  the same finished-state-clears-before-retry rule the other three jobs use.
- **Backend.** `ProjectConnectedInstanceService` (admin-gated like a restore),
  `POST /projects/:id/connected-instance` records `pending` and enqueues;
  `GET` is folded into the existing project response (`connectedInstance`
  block in `present()`), no separate endpoint needed — the data is small and
  already polled by the page. `GET /projects/:id/connected-instance/availability`
  reports whether this deployment can create one at all. The master password is
  sealed the same way `ProvisionProjectResult.masterPassword` is for
  `create_project`, through a second reveal route,
  `POST /projects/:id/connected-instance/master-password/reveal`, admin-only,
  audited with its own event pair — kept separate from the `create_project`
  reveal endpoint because the two are different machines' worth of
  credentials.
- **What the agent sees.** Nothing, same posture as ADR-067: the connected
  instance is never recorded as the project's own on-premise path, never
  wired into `execution-mode.ts`, and no task/validation/preview code path
  reads `connected_instance_*`.
- **Portal.** A "Create instance" panel on an `odoo_sh` project page, shown
  next to the restored-copy panel (both are relevant simultaneously — a
  restored copy for a person to check real data, a provisioned instance for
  the project owner to run their own restore into). Once `ready`, shows the
  HTTPS URL and a reveal-controlled master password, and tells the owner in
  plain text: open `<url>/web/database/manager` and restore your own backup
  there.
- **HTTPS is not optional here the way it is for `create_project`.** The
  operator's ask was explicit: the project's link must be `https://`, not
  `http://`. `PROJECT_HTTPS_ENABLED` must be `true` on the live `cartenz-api`
  process (verified via `/proc/<pid>/environ`, not just `.env`) before this
  feature is exercised; if it is not, `ProjectConnectedInstanceService`
  refuses the request up front with that exact reason rather than silently
  handing back an `http://` URL, unlike `create_project`'s "HTTPS is a
  best-effort upgrade" posture — this feature's whole point is the https
  link.

## Consequences

- A connected project can now carry up to three independent instances on this
  host: the project's own on-premise path (none, for `odoo_sh` — connecting
  never creates one), a restored copy (ADR-067, real customer data, locked
  down), and this provisioned instance (empty, reachable, for the owner to
  fill in). None of the three are the same thing and the portal must label
  each one distinctly — reusing `InstanceOverview`'s copy for this panel would
  misrepresent what the agent can reach.
- RAM: this host has ~370MB available with two `ai_project` instances already
  running (~730MB RSS total). A provisioned instance for even one connected
  project adds a comparable footprint; four (one per current `odoo_sh`
  project) will not fit without either raising host memory or capping
  `workers` lower than `create_project`'s default. Capacity, not code, decides
  how many of these run concurrently at once — measure `free -h` before each
  one, as `references/host-capacity-and-log-hygiene.md` already directs for
  every provisioning action on this host.
- The project owner reaching `/web/database/manager` can duplicate, restore
  over, or drop this instance's own database — deliberately, since giving
  them exactly that control is the feature. It cannot reach any other
  project's database: `dbfilter` pins the manager to this project's own
  database name, unchanged from every other provisioned project on this host.
