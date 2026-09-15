# ADR-039: A created project is a running Odoo instance, provisioned by the operator's own scripts

- Status: Accepted
- Date: 11 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Builds on ADR-032/036 (a created project is scaffolded locally), ADR-028 (execution
modes) and ADR-019 (the process chokepoint). Extended by ADR-040 (HTTPS and the
instance panel) and ADR-041 (the project's GitHub repository).

## Context

Creating a project produced a directory, a one-commit git repository and a set of
branches. It did not produce anything a person could open. The project existed in
the platform's database and as files on a disk, and there was no Odoo behind it —
no database, no service, no address. For a platform whose purpose is to change a
customer's Odoo, "create a project" that creates no Odoo is half a feature.

The host already knew how to do this. The operator's own scripts —
`/opt/odoo/scripts/create_project` and `create_project_enterprise` — create the
database, the filestore, the systemd unit, the Nginx site and the port allocation,
and they are what the operator has always used. They must run as root.

The platform runs as an unprivileged user (`cartenz`). So there were two ways to
get a running instance:

1. **Reimplement provisioning inside the platform.** This means the platform needs
   the privilege to create databases, write systemd units, edit Nginx and bind
   ports — a standing root-equivalent grant, held by a process that also runs
   model-authored tool calls. That is the opposite of the posture every other
   decision here has taken.
2. **Call the operator's existing scripts through a narrowly scoped grant.** The
   privilege stays in the operator's scripts, which already exist and are already
   trusted; the platform gets permission to invoke exactly those, with exactly the
   arguments they take.

The second is the only one compatible with ADR-019: the platform holds no general
privilege, and every process it starts is a fixed, validated shape.

A second fact surfaced while building it. `create_project` leaves the whole project
directory — including `addons/` — owned by `odoo:odoo`, mode 750. The platform user
cannot write into `addons/`, which is precisely where it must `git init` and commit.
And the git repository of such a project is `addons/`, not the project directory:
the project directory holds the instance (its configuration, its filestore), while
the thing under version control is the addons tree.

## Decision

### 1. The platform calls the operator's scripts; it does not reimplement them

Provisioning runs `create_project` or `create_project_enterprise` (by edition,
ADR-037) as root, via `sudo`. The platform supplies a project name and a port from
its configured range and reads the result; everything about how an Odoo instance is
built stays in the operator's script, where it already was.

### 2. `sudo` is an allowed executable, guarded by a setting that defaults to off

`sudo` joins `git` and `python3` in `ALLOWED_EXECUTABLES` at the process chokepoint,
and is refused outright unless `PROJECT_PROVISIONING_ENABLED=true` — the same
pattern as `GIT_PUSH_ENABLED` (ADR-021) and `VALIDATION_ENABLED` (ADR-027). With
the setting off there is no `sudo` for the process layer to run, whatever asked for
it and whatever permission or approval was recorded.

### 3. The grant is narrowed twice, by two gates that do not trust each other

Allowing `sudo` at all is a wide grant, so it is narrowed to a fixed shape
immediately, in two independent places:

- **A sudoers rule** (`infrastructure/provisioning/99-linkederp-provisioning`)
  grants the `cartenz` user `NOPASSWD` on a `Cmnd_Alias` naming exact absolute
  script paths, with no wildcard in any argument. `sudo -l -U cartenz` on the host
  shows exactly this and nothing else.
- **`assertProvisioningInvocation`** in `CommandRunner` re-validates every
  invocation against the configured script paths and argument shapes: the script
  must be one of the configured ones, the project name must be a valid name, and
  the port must be a valid port. Invocations always pass `-n`, so a TTY is never
  expected and a password prompt can never be waited on.

Neither gate is trusted alone. The sudoers rule limits what the host will allow
even if the platform is wrong; the code-level check limits what the platform will
attempt even if the sudoers rule is stale or over-broad.

### 4. The repository of a provisioned project is its `addons/`

Recorded as its own field, detected rather than configured. The workspace layer
requires `.git` at the recorded path, and the project directory has none — only
`addons/` does. This is what the record must name.

### 5. Ownership is fixed by a fourth script, not by widening the grant

`grant-addons-write.sh` makes `addons/` writable by the platform user after
`create_project` has chowned it to `odoo:odoo`. It is a separate, equally fixed
shape under the same `sudo` entry — not a new executable, and not a reason to relax
the mode the operator's script chose for the rest of the instance.

## Consequences

- A created project is something a person can open: a database, a service and an
  address, provisioned the same way the operator has always provisioned one.
- The platform holds no standing privilege. Its entire root-adjacent capability is
  the fixed set of script invocations named in one sudoers file, and it is off
  unless an operator turns it on.
- Provisioning is an operator-enabled deployment feature, not a default. A
  deployment that never installs the sudoers rule cannot provision, and says so
  rather than failing obscurely.
- The `addons/`-is-the-repository rule is load-bearing for every task on a
  provisioned project: a stale record naming the project directory made every task
  fail at workspace allocation with a message that sent the reader to the wrong
  place (fixed in ADR-041).
- Installing the sudoers rule and running a live provisioning test remain root
  actions, documented for the operator rather than performed by the platform.

## Verification

- Unit: `command-runner.spec.ts` asserts that `sudo` is refused with
  `PROJECT_PROVISIONING_ENABLED=false`; that only the configured script paths are
  accepted; and that a malformed project name or port is refused before a process
  is built.
- Host: `sudo -l -U cartenz` lists exactly the `Cmnd_Alias` and nothing else.
- End-to-end: a project created through the portal yields a reachable Odoo instance
  whose database, systemd unit and Nginx site exist, with `addons/` writable by the
  platform user and carrying the scaffolded commit.
