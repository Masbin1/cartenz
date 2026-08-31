# ADR-026 — On-premise deployment

**Status:** Accepted
**Date:** 2026-08-29

## Context

Chapter 17 puts on-premise Odoo in scope: the platform is installed on the same host as the
customer's Odoo, so it can read the addons directory directly rather than over a git remote.

A real on-premise host was inspected to find out what that actually means. The layout is what the
chapter assumes:

```
linkederp/
  base/odoo          Odoo 19.0 core, shared
  base/enterprise    enterprise addons, shared
  al3/               odoo.conf (port 8080) + AL3-Boerdery addons
  omnisurge/         odoo.conf (port 8069) + Odoo addons
  linkederp/Odoo     odoo.conf + the LinkedERP addons, a checkout of the GitHub repo
```

One Postgres instance serves all of it, with twelve Odoo databases beside the platform's own —
including `al3-prod-august`.

## The finding

**The platform's own database credentials could open every one of them.**

The platform is data-blind by design: no tool opens a database, and `database_export` and
`database_backup` are refused by name and cannot be granted. Those are properties of the code, and
they held — nothing was read.

But on this host the only thing between the agent and a customer's production records was that no
code path asks. That is the same shape of guarantee ADR-021 removed for `git push`: true today,
true because a feature is missing, and false the moment someone adds one. Data is the thing the
whole security model exists to protect, so the shape matters more here, not less.

The platform cannot fix it. Revoking a privilege on a database it does not own needs an operator.

## Decision

### 1. The platform reports what its credentials can reach, at every startup

`DatabaseService` asks Postgres, once, on bootstrap:

```sql
select datname from pg_database
where datallowconn and not datistemplate
  and has_database_privilege(current_user, datname, 'CONNECT')
```

`has_database_privilege` rather than connecting to each in turn: the platform must not open a
connection to a customer's production database in order to establish that it should not be able to.

Every reachable database is **named** in the warning, not counted. "11 databases" invites a shrug;
`al3-prod-august` does not. The remediation is given as the statement to run, because "restrict the
privileges" is one more thing to look up at the moment someone is least inclined to.

`postgres` and the templates are excluded — every client can reach the maintenance database and it
holds nothing, so naming it would make a clean deployment look unclean.

### 2. It does not refuse to start

Tempting, and wrong. A developer running the platform beside their own Odoo copies would be blocked
by a check that has nothing to say about their laptop, and the usual answer to a check that blocks
work is to remove the check. A warning that names `al3-prod-august` at every boot is harder to live
with than one that names a count, and does not create pressure to delete it.

### 3. `GET /health/posture` states the deployment's posture, publicly

Whether the platform can push, whether its credentials are isolated, and that the AI data boundary
is not configurable. Public, like the other health endpoints: someone deciding whether to connect a
repository should not need an account to find out that the platform cannot push, and an operator
should not have to read logs to find out whether its credentials reach a customer's database.

Reachable databases are **counted** here, not named. The names of a customer's databases are not the
platform's to publish on an unauthenticated endpoint. The startup log, which only an operator sees,
names them.

### 4. On-premise reads a working copy by cloning it, and that is a feature

Pointing the platform at `file:///…/linkederp/Odoo` clones it. `git clone` copies commits, not the
working tree, so nothing untracked reaches the workspace.

On the host inspected, that mattered: the working copy holds 107 untracked files, one of which is an
exported Odoo settings file containing a live-looking Google API key. It is not committed, not
gitignored, and would be staged by `git add -A`. The platform's clone did not contain it, and the
AI data boundary catches that key independently if it is ever read.

Two protections, in the right order: the file never enters the workspace, and if a future change
made it enter, the boundary would still stop it leaving.

## Consequences

An operator installing on premise now has one instruction that matters, and the platform states it
until it is followed:

```bash
sudo ./infrastructure/scripts/create-validation-role.sh
```

It revokes `CONNECT` from `PUBLIC` on every database that is not the platform's own, grants it back
to the Odoo role, and verifies the result. Plain `sudo`, not `sudo -u postgres`: on Ubuntu a home
directory is mode 0750, so the postgres user cannot read a script inside one.

The running Odoo is unaffected. Its role is a cluster superuser and owns the databases, and Postgres
skips the privilege check for both.

Revoking from `PUBLIC` and granting back is usually what is wanted: a fresh Postgres grants
`CONNECT` to `PUBLIC` on every database, which is why the platform's role could open them without
anyone having granted it anything.

What this does not do: it does not stop a determined operator pointing `DATABASE_URL` at a customer
database, and it does not protect against a Postgres superuser. It closes the default, which is
where this class of problem actually comes from.

## Verification

8 unit tests, and a live run against the on-premise host described above.

| What | Result |
| --- | --- |
| Reports an isolated deployment as isolated | PASS |
| Excludes `postgres` and the templates | PASS |
| Names each reachable database, sorted | PASS |
| Gives the `REVOKE` statement rather than an instruction | PASS |
| States plainly that the platform does not read them | PASS |
| **Live: 11 reachable databases named at startup, `al3-prod-august` among them** | PASS |
| `GET /health/posture` reports push disabled, not isolated, 11 others | PASS |
| **Live: an on-premise task against `file:///…/linkederp/Odoo`** | Odoo 19.0 detected, base commit `e88cbf3` matching the local HEAD, correct files planned |
| **Live: the clone contains no untracked file and no key** | PASS |
| The boundary catches the key in the untracked file | PASS — `google_api_key`, 2 occurrences |

**Not verified:** that the platform is *unable* to reach those databases. It is able to, on this
host, until the `REVOKE` is run. What is verified is that it says so.
