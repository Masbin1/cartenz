# Guide: Odoo version catalog and full-installation template databases

ADR-045. How an operator turns "every new project starts with all apps
installed" on, on a host that already provisions projects (ADR-039/040).

Two things are being set up, and they are independent:

| Thing | What it gives you | Where it is configured |
|---|---|---|
| **Version catalog** | A project of version *X* is generated against *X*'s own source: `odoo.conf`, `run.sh` and what the agent may read | Portal → Settings → Odoo versions |
| **Template databases** | A provisioned project's database is duplicated from a full installation, so every app of its edition is already there | `build-odoo-templates.sh` on the host, once per version |

The catalog works with provisioning off. The templates only matter when
`PROJECT_PROVISIONING_ENABLED=true`.

---

## 1. Lay out one source checkout per version

The catalog assumes one directory per version. A layout that works:

```
/opt/odoo/versions/
├── 18.0/
│   ├── odoo/          <- repo root, holds odoo-bin and addons/
│   └── enterprise/    <- enterprise addons (if you are entitled)
└── 19.0/
    ├── odoo/
    └── enterprise/
```

The **base path is the repo root**, the one holding `odoo-bin` — not
`odoo/addons`. This is the single most common mistake; the portal reports a
path that is not there, but it cannot tell you that a path which *is* there is
the wrong level.

Each version also needs a Python interpreter that can import that Odoo (Odoo
19 and Odoo 15 do not share dependencies):

```bash
python3 -m venv /opt/odoo/venv19
/opt/odoo/venv19/bin/pip install -r /opt/odoo/versions/19.0/odoo/requirements.txt
```

---

## 2. Register the versions in the portal

**Settings → Odoo versions → Register a version.** Fill in the version, the
base checkout and (for Enterprise work) the enterprise addons directory. A path
that does not exist on the server is refused rather than saved.

From then on a project created with that version is generated against that
version's source, and a community project of that version still does not get
the enterprise path (ADR-037 applies inside the catalog too).

A version with **no** row falls back to the single base path in **Settings →
Odoo source and projects**, so a one-version deployment can ignore this
section entirely.

---

## 3. Build the template databases (the slow, one-time step)

```bash
sudo /opt/cartenz/infrastructure/provisioning/build-odoo-templates.sh \
  19.0 \
  /opt/odoo/versions/19.0/odoo \
  /opt/odoo/venv19/bin/python \
  /opt/odoo/versions/19.0/enterprise
```

This runs `odoo-bin -i all --without-demo=all --stop-after-init` twice — once
for Community, once for Enterprise — and seals each result as a template:

```
cartenz_tpl_19_0_com    every Community module installed
cartenz_tpl_19_0_ent    every Enterprise + Community module installed
```

**Expect this to take a long time.** A full Enterprise install is commonly
20–60 minutes. It happens once per version; nothing repeats it per project.
Omit the last argument to build only the Community template.

Check the result:

```bash
sudo -u postgres psql -Atc \
  "select datname, datistemplate, datallowconn from pg_database where datname like 'cartenz_tpl_%'"
```

Both flags matter: `datistemplate = t` is what lets `CREATE DATABASE ...
TEMPLATE` use it, and `datallowconn = f` is both PostgreSQL's own requirement
for cloning and what stops anyone connecting to a template and drifting it.

Count what is installed, if you want the evidence:

```bash
sudo -u postgres psql -Atc "update pg_database set datallowconn = true where datname = 'cartenz_tpl_19_0_ent'"
sudo -u postgres psql -d cartenz_tpl_19_0_ent -Atc "select count(*) from ir_module_module where state = 'installed'"
sudo -u postgres psql -Atc "update pg_database set datallowconn = false where datname = 'cartenz_tpl_19_0_ent'"
```

---

## 4. Point the provisioning scripts at the templates

The operator's `create_project` / `create_project_enterprise` are **not** in
this repository — they are yours. Reference implementations carrying the exact
contract the platform expects are:

```
infrastructure/provisioning/create_project
infrastructure/provisioning/create_project_enterprise
```

Two changes are needed in whatever you actually run:

1. **Accept an optional third argument, the Odoo version.** The platform now
   calls `sudo -n <script> <name> <port> [<version>]`. A script that ignores a
   trailing argument keeps working; one that errors on it does not.
2. **Replace the database step** (`createdb` + `odoo-bin -i base`) with a call
   to `create-project-db.sh` when a version is given:

   ```bash
   "${SCRIPTS_DIR}/create-project-db.sh" "$PROJECT_NAME" enterprise "$VERSION" "$URL"
   ```

Copy the helper next to your scripts so the path above resolves:

```bash
sudo install -o root -g root -m 0755 \
  /opt/cartenz/infrastructure/provisioning/create-project-db.sh \
  /opt/odoo/scripts/create-project-db.sh
```

`create-project-db.sh` needs **no sudoers entry**: it is called by
`create_project`, which is already running as root. The sudoers rule is
unchanged by ADR-045.

What the helper does, in order: `createdb -T <template>`, then regenerate
`database.uuid` and set `web.base.url` on the clone, so no two project
databases share an instance identity. It **fails loudly** when the template for
that version is missing, rather than quietly giving you an empty database.

Keep the rest of your script's contract intact — particularly the master
password block, which the platform parses:

```
Odoo Master Password:

  <password>
```

---

## 5. Try it

Create a project through the portal with a registered version. Then, on the
host:

```bash
NAME=<technical_name>

# The database was cloned, not installed: this is near-instant and full.
sudo -u postgres psql -d "$NAME" -Atc \
  "select count(*) from ir_module_module where state = 'installed'"

# Its identity is its own.
sudo -u postgres psql -d "$NAME" -Atc \
  "select value from ir_config_parameter where key = 'database.uuid'"
```

Sign in and the apps menu is full on the first login.

---

## 6. Refreshing a template

A template fixes the module set at build time. When you want a newer one, run
`build-odoo-templates.sh` for that version again — it drops and rebuilds the
scratch database, and renames over the old template.

Rebuilding a template does **not** touch projects already created from it: the
clone was a copy, and it has been diverging since the moment it was made.

---

## 7. Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `the template database 'cartenz_tpl_19_0_ent' does not exist` | Templates never built for that version | Run `build-odoo-templates.sh 19.0 …` |
| `source database is being accessed by other users` | `datallowconn` was flipped back to true and something connected | Flip it to false and retry; nothing should hold a template open |
| New projects are still empty | The operator's scripts were never updated, so the version argument is ignored | Step 4 |
| Project generated against the wrong Odoo | The version has no active catalog row, so the single base path applied | Register it in Settings → Odoo versions |
| Full install fails partway | A module in `-i all` has an unmet Python dependency | See the log the script names (`<tmp>/<edition>.log`), install the dependency into that version's venv, rerun |
| Enterprise template skipped | No enterprise path passed to the build script | Pass it as the fourth argument |

---

## 8. ADR reference

| ADR | Topic |
|---|---|
| ADR-033 | Odoo paths in the portal (the fallback this builds on) |
| ADR-037 | Community/Enterprise per project |
| ADR-039 | Provisioning through the operator's own scripts |
| ADR-045 | The version catalog and the template databases |
