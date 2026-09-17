# ADR-054: Per-client backups, and the restore point before a staging push

- Status: Accepted
- Date: 18 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-026 (the estate on a hosting server), ADR-039 (root-run
provisioning scripts), ADR-049 (the pull's script-and-guard pattern), ADR-051
(standard databases) and ADR-052 (a seventh fixed sudo shape).

## Context

The operator's register item 4 asked for a backup to be triggered while pushing
new changes onto a staging or main database, and item 2 asked for an independent
backup/restore process per client. Neither existed: the platform held no backup
machinery at all.

Three facts decide the shape:

1. **The platform's own role cannot read a project's database.** `pg_dump` as
   `cartenz` dies on tables it does not own, and the project directory is
   `odoo:odoo` mode 750. A backup therefore runs as root, through the same
   script-and-guard pattern as provisioning and the pull.
2. **A backup only the platform can restore is not a backup.** The point of the
   feature is that custody of the backup and custody of the platform are
   separable: an operator with server access and no platform access must be able
   to restore a client's estate, and a client's estate must be transferable at
   the end of an engagement.
3. **A promotion must always have an immediately preceding restore point**, so
   rolling back is a restore rather than a repair.

## Decision

### 1. A root-run `backup-project.sh`, one shape, seven scripts in the allow-list

`infrastructure/provisioning/backup-project.sh <project-name>` snapshots, into
`/opt/odoo/backups/<project>/<UTC-timestamp>/`:

| Piece | Source | Notes |
| --- | --- | --- |
| `db.dump` | `pg_dump --format=custom`, as postgres | Compressed; refused when the database is absent |
| `filestore.tar.gz` | `<project>/data/filestore/<db>` | Attachments and generated documents; travel with the database or they break |
| `addons.bundle` | `git bundle --all`, as the `odoo` user | Every branch of the addons repository, a fallback for the remote |
| `manifest.json` | written **last** | Its presence marks the backup complete; a directory without one is never restored |

Retention keeps the newest `BACKUP_KEEP` (default 14) runs per project. The
script prints its own facts (`BACKUP_ID=`, `BACKUP_PATH=`, `BACKUP_SIZE_BYTES=`)
and the platform reads them back rather than guessing at a root-owned path.

The sudoers `Cmnd_Alias` gains a seventh entry and
`assertProvisioningInvocation` a matching shape - `-n <backup-script>
<project-name>`, the same shape as the grant script, distinguishable only by the
configured path. `PROJECT_BACKUP_SCRIPT` follows the `PROJECT_PULL_SCRIPT`
posture: defaulted, and empty disables the feature end to end.

### 2. The pre-push hook: a failed backup blocks the push

`AgentWorkflow.push()` takes the backup **before** the push, and only when the
push promotes work: a `staging`-kind environment, or a `main`-named branch.
Development pushes are routine and are not guarded.

Three outcomes, deliberately distinct:

- **taken** - narrated with the backup's own id, so the restore point is
  findable from the task record. The push proceeds.
- **skipped** - no provisioned instance on this host, or the deployment has no
  backup script configured. Narrated; the push proceeds. Failing it would blame
  the person for a fact about the project or the host.
- **failed** - the task fails and nothing is pushed. A promotion without its
  restore point is the one case this exists to prevent.

Each backup is recorded in a new `project_backups` table (status, reason,
`pre_push`/`manual`, path, size, error, the task it was taken for) and audited as
`project.backup_created` / `project.backup_failed` - a backup is a host action
that outlives the task that requested it.

### 3. `restore-project.sh` is an operator's tool, not a platform surface

The restore is deliberately **not** in the sudoers rule and has no API: run as
root, it prints a plan and requires `--yes`, stops the instance's unit, replaces
the database (`dropdb`/`createdb`/`pg_restore` as the `odoo` role), moves the
current filestore aside and extracts the archived one, leaves `addons/` alone
(its remote is the primary copy; the bundle is the fallback, with the commands
printed), and starts the unit again. The restore is expected to be exercised as
a drill, not assumed.

### 4. The portal surface

`GET/POST /projects/:id/backups` and a panel on the instance: whether this
deployment can back up, the last three runs with their status and size, and a
"Back up now" button. Taking a backup is a project-scoped action, gated by
`requireProjectAccess` like the pull; it touches nothing the requester cannot
already reach.

## Consequences

- The estate now has a restore point per promotion and an independent backup an
  operator can use without the platform; the retention lives on the same host,
  so off-host replication remains an operator concern (documented, not built).
- A deployment that enables provisioning but has not installed the seventh
  sudoers entry will fail a staging push at the backup step with "a password is
  required" - the install and the restart must happen together. This is the one
  sharp edge of the design; it is stated in the install guide and the runbook.
- The first live backup on a host is an operator-verifiable step: run the script
  directly once, restore it once as a drill, then trust the automatic path.

## Retirement

If a managed backup service (with off-host retention and its own restore
tooling) is adopted, these scripts become the drill path and this ADR is
superseded. The pre-push guarantee - a promotion cannot proceed without a fresh
restore point - must survive in whatever replaces them.
