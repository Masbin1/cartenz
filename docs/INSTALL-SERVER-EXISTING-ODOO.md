# Cartenz on a Server that Already Runs Odoo

Installation and path guide for a single Ubuntu host that already runs Odoo —
source checkout, enterprise addons, Python environment and PostgreSQL are all
present before Cartenz arrives. The platform must point at that estate, never
copy or shadow it.

Read this together with [INSTALL-SERVER.md](INSTALL-SERVER.md), which covers the
generic install (database, 9router, systemd, TLS, backup). This guide covers
only what changes when Odoo is already on the box: **where the paths come from,
which layer configures them, and what may touch what.**

---

## 1. The two layers of path configuration

Odoo paths are configured in **two layers**, and they do not both apply at once:

| Layer | Where | Status |
| --- | --- | --- |
| Portal settings (ADR-033) | **Settings → Odoo** per organisation: `base_path`, `enterprise_path`, `projects_root` | **Authority** — used when a row exists |
| Environment fallback (ADR-031) | `.env` on the server: `ODOO_SOURCE_PATHS`, `ON_PREMISE_READ_ONLY_PATHS`, `ODOO_RUNTIMES`, `ODOO_SHARED_ADDON_PATHS`, `ODOO_PYTHON` | Used only when an organisation has **no** portal row |

The portal is preferred on a server: an operator edits paths in a screen, the
endpoint checks each path **exists on the host at the moment it is saved**, and
a mistake is reported when it is typed rather than at the first task. The `.env`
layer exists so a deployment can run before anyone opens the portal.

> **A deployment serving one organisation can set both to the same values.**
> Portal wins once set; `.env` is the pre-portal fallback and the source for the
> worker's validation runtime settings (`ODOO_RUNTIMES`, `ODOO_PYTHON`), which
> have no portal equivalent and are always read from `.env`.

---

## 2. Discover what the server already has

Run these **on the server** before configuring anything. They find the estate
rather than assuming a layout.

```bash
# Who runs Odoo, and from where?
ps aux | grep -E '[o]doo' | head -5
systemctl status odoo --no-pager 2>/dev/null | head -10   # or odoo17 / odoo18 / ...

# The Odoo process command line usually shows: --addons-path, config file
tr '\0' ' ' < /proc/$(pgrep -f '[o]doo-bin|odoo/odoo-bin' | head -1)/cmdline 2>/dev/null
echo

# Config file -> addons_path, db_host, db_user
sudo grep -E "addons_path|db_(host|port|user|name)" /etc/odoo*/odoo.conf 2>/dev/null

# Base source checkout (contains odoo-bin and addons/odoo/)
find /opt /srv /home -maxdepth 4 -name "odoo-bin" -type f 2>/dev/null

# Enterprise addons folder (contains the *enterprise* addons, e.g. account_enterprise)
sudo find /opt /srv /home -maxdepth 4 -type d -name "enterprise" 2>/dev/null

# The Python that runs Odoo
ls -la /opt/odoo*/venv/bin/python 2>/dev/null
sudo grep -E "^(ExecStart|Environment)" /etc/systemd/system/odoo*.service 2>/dev/null

# PostgreSQL: which cluster, which roles exist
sudo -u postgres psql -tAc "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg_%'"
sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datistemplate = false"
```

Fill the discovery table below from the output — these exact values are what
the next sections need.

| Thing to find | Example (typical Odoo 19 layout) | Your server |
| --- | --- | --- |
| Odoo version(s) served | `19.0` | |
| Base source path | `/opt/odoo19` | |
| Enterprise path | `/opt/enterprise` | |
| Python venv for Odoo | `/opt/odoo19/venv/bin/python` | |
| PostgreSQL host / port | `127.0.0.1:5432` | |
| Odoo database role | `odoo` (do **not** reuse for Cartenz) | |
| Cartenz install root | `/opt/cartenz` (choose) | |
| Cartenz projects root | `/opt/cartenz-projects` (choose, **writable**) | |

---

## 3. Ownership rules: who may read, who may write

The security property of the whole layout is **one writable directory per
project, everything else read-only** (ADR-031, ADR-033).

| Path | Cartenz worker may | Because |
| --- | --- | --- |
| Odoo base source (`/opt/odoo19`) | **read** (as reference on every Odoo task) | The agent reads `odoo/addons/sale/...` to plan; a write is refused at the process layer |
| Enterprise (`/opt/enterprise`) | **read** | Same rule — and a community project must not even read it (ADR-037) |
| `projects_root/<project>/addons/` | **write** | The only writable Odoo path; modules are created here |
| Odoo customer databases | **nothing** | Validation uses a dedicated role with `CREATEDB` and nothing else (see §7) |
| Platform database `linkederp_ai` | Cartenz owns it | Created by install-server.sh |

Permissions to make on the server:

```bash
# The cartenz service user must be able to READ the Odoo source (world-readable
# is typical for /opt/odoo19); it must NEVER own or be able to write it.
sudo ls -ld /opt/odoo19 /opt/enterprise          # expect drwxr-xr-x

# If they are not world-readable, add the cartenz user to the owning group.
# Do NOT chown Odoo's files to cartenz.
sudo usermod -aG odoo cartenz                   # example only — match the real group

# The projects root is Cartenz's own territory.
sudo mkdir -p /opt/cartenz-projects
sudo chown cartenz:cartenz /opt/cartenz-projects
```

---

## 4. Configure the `.env` path settings (server)

Edit `/opt/cartenz/.env` (created by `bootstrap-env.sh`, see
[INSTALL-SERVER.md §4.2](INSTALL-SERVER.md)). The path block:

```bash
# ---- Workspaces (per-task clones) ------------------------------------------
WORKSPACE_ROOT=/opt/cartenz/.runtime/workspaces

# ---- Odoo reference source the agent may read on EVERY Odoo project ---------
# Comma-separated absolute paths. If unset, derived from the union of
# ON_PREMISE_READ_ONLY_PATHS, ODOO_SHARED_ADDON_PATHS and the ODOO_RUNTIMES
# values. Set explicitly to have the reference without depending on validation.
#   base + enterprise, read-only, exposed to the model as odoo/... and enterprise/...
ODOO_SOURCE_PATHS=/opt/odoo19,/opt/enterprise

# ---- On-premise projects (ADR-028) -------------------------------------------
# Base directory under which on-premise projects live. Empty disables on-premise
# execution. Optional if you only use portal-created projects.
ON_PREMISE_ROOT=/opt/cartenz-projects
# Same read-only Odoo directories as ODOO_SOURCE_PATHS (legacy derivation input).
ON_PREMISE_READ_ONLY_PATHS=/opt/odoo19,/opt/enterprise

# ---- Validation runtimes (which core serves which series) -------------------
# version=/abs/path pairs. A project whose series is absent is skipped, never
# run against the wrong core. Multiple series: 19.0=/opt/odoo19,18.0=/opt/odoo18
ODOO_RUNTIMES=19.0=/opt/odoo19

# Addon directories shared across every series (enterprise, OCA...).
ODOO_SHARED_ADDON_PATHS=/opt/enterprise

# The interpreter a validation run uses to start Odoo. MUST be the venv whose
# dependencies match the runtime above (not the system python3).
ODOO_PYTHON=/opt/odoo19/venv/bin/python
```

Then re-read the values Cartenz actually resolves at boot:

```bash
cd /opt/cartenz
set -a; . ./.env; set +a
echo "ODOO_SOURCE_PATHS=$ODOO_SOURCE_PATHS"
echo "ODOO_RUNTIMES=$ODOO_RUNTIMES"
echo "ODOO_PYTHON=$ODOO_PYTHON"
```

### 4.1 Common layouts and the values they map to

| Existing layout on the server | `ODOO_SOURCE_PATHS` | `ODOO_RUNTIMES` |
| --- | --- | --- |
| Single Odoo 19, base + enterprise under `/opt` | `/opt/odoo19,/opt/enterprise` | `19.0=/opt/odoo19` |
| Single Odoo 17 under `/srv/odoo` with enterprise in it | `/srv/odoo,/srv/odoo/enterprise` | `17.0=/srv/odoo` |
| Several series (17 + 19) | `/opt/odoo19,/opt/odoo17,/opt/enterprise` | `19.0=/opt/odoo19,17.0=/opt/odoo17` |
| Only base, no enterprise licence | `/opt/odoo19` | `19.0=/opt/odoo19` |

Rule of thumb: every path must **exist and be readable by the `cartenz`
user**. A path that merely points at a folder is a task-time failure waiting to
happen.

---

## 5. Configure the portal Odoo settings (per organisation)

For the organisation that owns the work, set the same estate in the portal so
it no longer depends on `.env`:

1. Portal → **Settings → Odoo**.
2. Fill the three fields with absolute paths **on the server**:
   - **Base path** — e.g. `/opt/odoo19`
   - **Enterprise path** — e.g. `/opt/enterprise` (leave empty if none)
   - **Projects root** — e.g. `/opt/cartenz-projects` (must be writable)
3. Save. The endpoint reports which paths exist on the host; fix any that come
   back missing **before** creating projects.

The effect (ADR-033):
- `<projects_root>/<project_name>/` becomes the git repository.
- `<projects_root>/<project_name>/addons/` is the **only writable** Odoo path.
- `base` and `enterprise` stay read-only roots for every task of that
  organisation.

The environment fallback (§4) stops applying to that organisation the moment
the row is saved.

---

## 6. Creating the first project — what the paths produce

With the layout above, a Create-with-AI project "acme" produces:

```
/opt/cartenz-projects/acme/
├── .gitignore
├── addons/            <- writable; the agent creates modules here
│   └── .gitkeep
└── (git repo, branch main, Development environment — ADR-021/034)
```

A task on that project can read `/opt/odoo19` (as `odoo/...`) and
`/opt/enterprise` (as `enterprise/...`) to plan, and can write only under
`addons/`. Validation runs Odoo from `ODOO_RUNTIMES` with `ODOO_PYTHON`
against a throwaway database (next section).

---

## 7. Validation database role (do this once, per cluster)

Validation is not a read: it creates a database, installs modules and runs code
that writes. It must **never** run as the Odoo role — on a typical host that
role is a Postgres superuser owning every customer database.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE linkederp_validation LOGIN CREATEDB PASSWORD 'CHANGE_ME_STRONG';
REVOKE CONNECT ON DATABASE "<each-customer-db>" FROM PUBLIC;
REVOKE CONNECT ON DATABASE "<each-customer-db>" FROM linkederp_validation;
SQL
```

The shipped script does this for you:

```bash
sudo -u cartenz bash /opt/cartenz/infrastructure/scripts/create-validation-role.sh
```

Then in `/opt/cartenz/.env`:

```bash
VALIDATION_ENABLED=true
VALIDATION_DB_USER=linkederp_validation
VALIDATION_DB_PASSWORD=CHANGE_ME_STRONG
VALIDATION_DB_HOST=127.0.0.1
VALIDATION_DB_PORT=5432
```

Restart the worker after editing `.env` (settings are read at boot):

```bash
sudo systemctl restart cartenz-worker
curl -s http://127.0.0.1:4000/api/v1/health/posture | python3 -m json.tool
```

The posture endpoint reports `database.otherDatabasesReachable` — with the
`REVOKE CONNECT` lines applied it should drop, and `git.pushEnabled` should be
`false` until push is intended (ADR-021).

---

## 8. Path troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Portal refuses to save Odoo settings | A path does not exist on the host | Check spelling and that the path is on the **server**, not your laptop |
| Task plan cites files but validation says "no module found" | `addons_path` points at the parent of the modules (pre-ADR-034 behaviour) | Confirm `<project>/addons/` is the layout; rebuild/upgrade if old |
| "This project has no environments declared" | Project was created before ADR-034 | Recreate the project (creation now always makes a Development env) |
| Validation skipped / "not faked" | `VALIDATION_ENABLED=false`, or series missing from `ODOO_RUNTIMES` | Enable and add the right `version=/path` pair; restart worker |
| Validation starts but dies importing Odoo | `ODOO_PYTHON` is the system interpreter, not the venv | Point it at the venv whose deps match the runtime |
| `health/posture` shows other databases reachable | `REVOKE CONNECT` not run for customer DBs | Run the revokes in §7 |
| Agent wrote into base/enterprise (should be impossible) | Old version, or `ODOO_SOURCE_PATHS` unset so roots derived wrongly | Upgrade; set paths explicitly in portal |
| Odoo itself cannot start after install | Cartenz install touched Odoo's files | Cartenz never writes there — check you did not `chown` Odoo to `cartenz` |

---

## 9. Verification checklist

- [ ] `ps`/`systemctl` discovery in §2 completed; all paths written down
- [ ] `cartenz` user can read base and enterprise; **owns neither**
- [ ] `/opt/cartenz-projects` exists, owned by `cartenz`, empty
- [ ] `.env`: `ODOO_SOURCE_PATHS`, `ODOO_RUNTIMES`, `ODOO_PYTHON` set and exist
- [ ] Portal Settings → Odoo saved with paths that passed the exists-check
- [ ] `linkederp_validation` role created; customer DBs revoked from it
- [ ] `VALIDATION_ENABLED=true`; worker restarted; posture re-checked
- [ ] One Create-with-AI project made; a task planned, implemented and validated
      end to end on a non-`main` branch
