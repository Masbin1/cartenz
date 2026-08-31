# ADR-027 — Running Odoo for validation

**Status:** Accepted (built and wired; not yet exercised against a live Odoo run)
**Date:** 2026-08-29
**Amends:** ADR-013 (isolation boundary), ADR-019 (process chokepoint)

## Context

Phase 4 is validation: running the repository's own tests so that a change is checked before a
person is asked to approve it. It has been deferred because running a repository's test suite
executes its code, and ADR-013 puts that behind a microVM the platform does not have.

Inspecting a real on-premise consultancy host changed the shape of the question, and the change is
worth stating precisely, because it would be easy to use it to wave the problem away.

**What is different.** The code is the customer's own, on the customer's own server, where it
already runs in production. The platform is not being asked to execute a stranger's repository. It
is being asked to run code that already runs here.

**What is not different.** The agent's *changes* are new, unreviewed, and machine-authored. And the
host is not a neutral place to run them: the `odoo` role on the host inspected is a Postgres
superuser owning twelve databases, one of them `al3-prod-august`. An Odoo test run is not a read —
it creates a database, installs modules, and runs code that writes.

So the microVM is still the right long-term boundary, and running as the customer's Odoo role is
still unacceptable. What is newly possible is a middle position: a bounded runner that cannot reach
the customer's data, disabled by default.

## Decision

### 1. Off by default, refused at the process chokepoint

`VALIDATION_ENABLED` defaults to false, and with it false `CommandRunner` refuses to start Python at
all — before argument validation, before a process exists. This is the shape ADR-021 established
for `git push`, and the reason is the same: a guarantee that rests on a tool being unimplemented
ends the moment somebody implements it.

Enabling it lets the platform start a process on the customer's server. That is an operator's
decision about a host, not a permission a project can grant itself, so it is not in the permission
model at all.

### 2. Enabling it permits an Odoo run, not Python

`python3` is on the allow-list only so `odoo-bin` can be started, and adding an interpreter to that
list is a wide grant. It is narrowed to one shape: the first argument must be an `odoo-bin` inside
a directory configured as an Odoo runtime.

`-c 'import os'`, `-m http.server`, a bare interpreter, a different script in the core directory,
and a path like `/opt/odoo19-evil/odoo-bin` are all refused. The permitted directories come from
configuration, never from the caller.

### 3. A runtime per series, configured rather than guessed

`ODOO_RUNTIMES=19.0=/opt/odoo19,18.0=/opt/odoo18,17.0=/opt/odoo17`. The project's series is detected
from its manifests and mapped to a core.

A series with no configured runtime is **skipped**, and the reason names the series and what is
configured. Running 18.0 code against a 19.0 core produces a page of import errors that look like
the change is broken when the runtime is simply wrong, which is worse than not running the tests.

This is what makes the platform version-agnostic in the way a consultancy needs: 17, 18, 19 and
whatever 20 turns out to be are configuration, not code.

### 4. The Odoo configuration is generated, never the customer's

Their `odoo.conf` holds `admin_passwd` and `db_password`, and its `addons_path` points at the live
addons directory the running server loads. Reusing it was the obvious shortcut and would have meant
every test run held a superuser credential and could load the live code.

The generated file puts the **workspace clone** first on the addons path — validating the code the
agent changed is the entire point — then the shared directories, then the core. It sets
`list_db = False`, `workers = 0`, `max_cron_threads = 0` and `without_demo = all`. It contains no
password: that reaches the process through the environment, for the life of that process.

### 5. Its own Postgres role, and a database name it cannot mistake

Validation authenticates as a dedicated role with `CREATEDB` and nothing else — never the
customer's Odoo role.

The database name is generated, not supplied: `linkederp_validation_<task>_<attempt>`. Names are
checked before create and again before drop, and anything without that prefix is refused. The drop
is the one that matters: a bug that passed a customer's database name to a drop would be
unrecoverable, and no amount of care at the call site is worth as much as a check at the bottom.

Names longer than 63 bytes are refused rather than truncated, because Postgres truncates silently
and two runs differing only after the cut would become one database.

### 6. The runner cleans up in a `finally`, and reports honestly when it cannot run

`OdooValidationRunner` creates the scratch database, writes the conf beside the clone rather than
inside it, runs the process under a timeout, and drops the database in a `finally` — so a crash, a
timeout and a thrown error all leave the same thing behind, which is nothing. A drop that fails is
logged with the database name and never thrown, because a cleanup failure must not mask the test
result somebody is waiting for.

When it cannot run it returns a reason rather than a failure, and the workflow narrates it and falls
through to the simulated path. Failing a task because an operator has not configured a Postgres role
would be failing it for something the person reading it cannot act on.

The modules to install come from `git diff`, not from the plan: the plan is a statement of intent,
and what needs testing is what actually changed.

## Consequences

Validation is wired end to end and off. On a deployment with no runtime configured — which is every
deployment today — the behaviour is unchanged: the simulated tools run and say so.

The simulated summary was reworded while doing this. It said "Validation passed: 3 step(s),
simulated", which reads as a pass, and read worse still directly after a line explaining that the
real run had been skipped. It now says no repository code was executed and that this is not evidence
the change works.

**What this does not contain.** The Odoo process runs as the platform's Unix user, with that user's
filesystem access. A bounded database role does not stop AI-authored code reading the host's files.
That is what ADR-013's microVM is for, and this does not replace it — it makes the intermediate step
safe enough to be worth having, on a host where the alternative is no validation at all.

## Verification

39 unit tests, and 11 checks against the compiled artefact.

| What | Result |
| --- | --- |
| `19`, `19.0` and `19.0.1.0.3` select one runtime | PASS |
| A relative core path, or an entry with no series, is refused | PASS |
| 20.0 against a 19.0-and-17.0 host is skipped, naming what is configured | PASS |
| The generated conf holds no password, and puts the workspace first | PASS |
| A name Postgres would truncate is refused | PASS |
| **`al3-prod-august` and every other customer database is refused for create and drop** | PASS |
| `--stop-after-init` is always present, so this is a validation and not a server | PASS |
| **Compiled: with validation off, no Python may start** | PASS — 4 forms |
| **Compiled: with validation on, only a configured `odoo-bin` may start** | PASS — 6 forms refused, control permitted |
| The runner refuses without a role, and says never to use the Odoo one | PASS |
| It skips a series it has no runtime for, naming what it has | PASS |
| It skips a change that touched no module | PASS |
| A malformed `ODOO_RUNTIMES` does not stop the platform booting | PASS |
| A crashed run is never summarised as "0 failed" | PASS |
| The verdict comes from the exit code, not from parsing | PASS |
| `.github` is not mistaken for an addon called `github` | PASS |
| **Live, on-premise: enabled with a runtime but no role, the task says exactly that** | PASS |

**Not verified:** an actual Odoo test run. It needs a Postgres role that does not yet exist on the
host — the platform's own role cannot create databases, and the customer's Odoo role requires a
password held in their `odoo.conf`, which was deliberately not read. Creating that role is the next
step and it belongs to an operator.
