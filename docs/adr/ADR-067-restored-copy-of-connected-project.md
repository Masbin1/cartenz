# ADR-067: Restored copy of a connected odoo.sh project

Status: Accepted (2026-09-27)

Relates to: ADR-050 (repository-backed connected projects), ADR-052 (ephemeral
preview), ADR-054 (per-client backups), ADR-057 (restart onto a branch).

## Context

Connecting an existing odoo.sh project gives the platform a repository and
nothing else (ADR-050). Cartenz's only access to odoo.sh is a git push; there
is no customer instance it could "connect to", and ADR-050 §3 is explicit that
the customer's database is never replicated and the AI never works against
customer data.

Operators still need to see the customer's real data somewhere: to understand
the business before specifying work, and to check a finished change against
real records rather than the standard database. The Cartenz team has odoo.sh
access and can download a staging backup themselves - no customer-side
credential or API is involved.

Two decisions were taken with the operator before building this:

1. **Who uses the restored copy.** A human only. The agent keeps working on the
   project's own standard, template-built database exactly as before. ADR-050
   §3 is unchanged.
2. **How the backup reaches the host.** The operator copies the odoo.sh zip
   to one fixed staging directory on the server (`scp`) and picks it in the
   portal. No browser upload: odoo.sh backups routinely run to hundreds of MB
   or more, and the portal's Nginx `client_max_body_size` is 12M.

## Decision

A connected odoo.sh project can have one **restored copy**: a NEW Odoo
instance on the Cartenz host, loaded from an odoo.sh backup zip.

- **Staging directory.** `PROJECT_RESTORE_STAGING_DIR`
  (default `/opt/cartenz/restore-staging`, mode 700, owned by `cartenz`). The
  API lists `*.zip` files in it for the portal; nothing else reads it.
- **Script.** `infrastructure/provisioning/restore-existing-instance.sh`, run
  as root through sudo (the tenth grant in `99-linkederp-provisioning`):
  `<instance-name> <port> <zip-basename> [<repository-url> <branch>]`.
  - The zip is a basename, never a path; the script resolves it inside the
    staging directory and refuses anything that resolves elsewhere or is a
    symlink. The backend guard (`assertProvisioningInvocation`) refuses the
    same shapes before sudo is reached.
  - Validates the zip (`dump.sql` present) and that its `manifest.json` Odoo
    series matches the host's before creating anything.
  - Optionally checks out the project repository into `addons/` via the
    existing `pull-project.sh` (credential on stdin, never argv), so the
    customer's own modules are on the addons path at first load.
  - Loads with Odoo's own `odoo-bin db load --neutralize` - no custom parser
    for `dump.sql`/`filestore/`. Neutralization (outgoing mail servers, crons,
    payment providers, webhooks off; `database.secret` replaced) happens before
    the registry ever starts.
  - Refuses to start unless `database.is_neutralized` is set on the loaded DB.
  - Runs the instance bound to `127.0.0.1` only, `list_db = False`,
    `workers = 0`, `max_cron_threads = 0`; no Nginx site is created. A random
    master password is written to the config and never printed.
  - On any failure, removes what it created (unit, database, directory).
- **Backend.** `ProjectRestoreService` (admin-only, like a restart) records
  `restored_status = 'pending'` and enqueues a job on the provisioning queue;
  the worker runs the script and records `restored` / `failed`. Port allocation
  checks both `provisioning_port` and `restored_port`. New columns on
  `projects` (migration `0025_restored_instance.sql`): `restored_status`,
  `restored_instance_name`, `restored_port`, `restored_backup_file`,
  `restored_error`, `restored_at`. Audit events
  `project.restored_instance_{requested,created,failed}`.
- **What the agent sees.** Nothing. The restored copy is never recorded as the
  project's `provisioning*` instance or on-premise path, and no task,
  validation or preview code path reads the `restored_*` columns.
- **Portal.** A "Restored copy of the odoo.sh instance" section on the project
  page, shown for odoo.sh projects. It states in the UI that the agent never
  works on it.

## Consequences

- Real customer data now lives on the Cartenz host. It is neutralized, bound
  to localhost, and reachable only by operators; it is still customer data and
  must be treated as such (host access, backups of the host, deletion when the
  engagement ends).
- One more resident Odoo process per restored project. On the current 1.9GB
  host this is the binding constraint: one or two restored copies at most.
- No delete path yet. Removing a restored copy is a manual root operation
  (stop/disable the `odoo-<instance>` unit, `dropdb`, remove the project
  directory, reset the `restored_*` columns). Added when it is first needed.
- Only one restored copy per project; asking again while one exists is refused.
- Reaching the instance from a browser needs an SSH tunnel or a firewall/Nginx
  decision by the operator, since it listens on 127.0.0.1 only.
