# Cartenz Standard Databases

This folder holds **LinkedERP's own standard Odoo databases** — one per edition and
region. They are used wherever an Odoo database is needed for work that involves the
AI: validation, UI preview, and a replica on-premise instance. The client's own
database is never restored into a platform-hosted instance for AI testing, so client
business data never reaches a model or an agent workspace.

If a client provides an example database, restoring it is a **separate, manual,
explicit** action — never the database the AI works against.

---

## 1. Naming convention

```
linkederp-standard-<edition>-<region>-v<major>.zip
```

| Part | Values | Notes |
| --- | --- | --- |
| `edition` | `enterprise`, `ce` | `ce` = Community |
| `region` | `indonesia`, `south-africa`, `india` | Matches `USER_REGIONS` (enum uses `south_africa`) |
| `major` | `18`, `19`, … | The Odoo **series**, so `v19` means Odoo `19.0` |

There is **one file per edition, region and Odoo series**. Odoo 18 and 19,
Enterprise, South Africa:

```
linkederp-standard-enterprise-south-africa-v18.zip
linkederp-standard-enterprise-south-africa-v19.zip
```

**Which file a project gets is decided by version + edition + region.** A project
declared `19.0` / Enterprise / Indonesia resolves to exactly one file:

```
linkederp-standard-enterprise-indonesia-v19.zip
```

`database/manifest.json` is the authoritative catalog — the resolver reads it, not the
file name. A file whose `odooVersion` is not set in the manifest is not usable.

> The first six files were supplied **without** a version and with mixed separators
> (`enterprise-south-africa` uses hyphens, `ce.south-africa` uses a dot). They are
> listed in `manifest.json` with `odooVersion: null`; rename them to the convention
> above (normalise the dot to a hyphen, add `-v<major>`) and set the version in the
> manifest before the catalog is used.

---

## 2. How a standard database is used

```
project (edition + region + odooVersion)
        │
        ▼
database/linkederp-standard-<edition>-<region>.zip
        │   (built into a template once, on the host)
        ▼
cartenz_tpl_<version>_<edition>_<region>      ← PostgreSQL template
        │   (CREATE DATABASE ... TEMPLATE, seconds)
        ▼
project database  ──►  Cartenz-hosted Odoo (validation / preview / on-prem replica)
```

This is an extension of ADR-045 (centralised Odoo versions and template databases):

- The **zip is the portable source of truth** — the baseline LinkedERP ships.
- The **template** is the host-local cache built from the zip, so project creation
  stays a fast clone rather than a restore.
- Template naming gains the region: `cartenz_tpl_<version>_<edition>_<region>`.
  A deployment with one region may keep the shorter ADR-045 name as a fallback.

The AI never touches a client database by construction: the code comes from the Git
clone/replica, and the database comes from this folder.

---

## 3. Restore rules (for the operator scripts)

A zip is Odoo's own backup format: a `dump.sql` plus a `filestore/` directory.

1. **Validate before restoring** — reject path traversal (`../`), absolute paths and
   oversized entries; cap the uncompressed size.
2. **Restore as the operator, not the AI.** This runs in the provisioning stage,
   behind root/sudo, exactly as `create_project` does.
3. **Neutralise the clone** so no two instances share an identity:
   - regenerate `database.uuid`
   - set `web.base.url` per project
   - set the admin password per project (never kept in the zip)
   - scrub stored credentials baked into the standard DB (mail servers, payment
     providers, API keys) before sealing it as a template.
4. **Filestore is keyed by database name** — place it under the correct
   `<dbname>/` or the clone starts with broken attachments.

---

## 4. Decisions taken, and what remains open

**Decided:**

1. **The version is part of the name.** A standard DB for `19.0` cannot be restored
   into `17.0`, and the catalog holds several versions per region, so the version is
   required in both the file name and `manifest.json`.
2. **The zips are committed with git.** They are tracked in the repository; `.gitignore`
   ignores extracted dumps and archives (`*.sql`, `*.sql.gz`, `*.dump`) but **not**
   `*.zip`. Note: a full Enterprise DB plus filestore can be hundreds of megabytes, and
   git stores every version of every binary forever. If the repository grows
   uncomfortably, the same files can move to Git LFS without changing this design.
3. **The customer's server pulls the branch itself.** Cartenz's job ends at changing the
   code and pushing it to the customer's GitHub repository. The customer's host is the
   deployment target and pulls on its own side (webhook, CI or scheduled `git pull`).
   Cartenz does **not** deploy to that host and does not hold an SSH path to it; the
   Phase 6 connector is not used for this (ADR-050).

**Still open / to respect:**

4. **`odoo.sh` cannot be force-restored.** An Odoo.sh instance builds and owns its own
   database; Cartenz cannot push a zip into it automatically. The standard DB is used
   there for **local preview/validation only**. The full restore flow above applies to
   Cartenz-hosted instances (the on-premise replica of the connected-server design, and
   preview instances).
5. **Region mismatch.** `USER_REGIONS` uses `south_africa`; the file name uses
   `south-africa`. The resolver must normalise `-`/`_` rather than compare literally.

---

## 5. Adding a new standard database

1. Produce the zip with Odoo's database manager (backup → includes filestore).
2. Scrub credentials and confirm the admin password is not relied upon.
3. Name it per §1.
4. Add an entry to `manifest.json` with `edition`, `region`, `odooVersion` and
   `sha256`.
5. Rebuild the host template from it:
   `infrastructure/provisioning/build-odoo-templates.sh` (region-aware build is the
   next step; see §4 and the architecture document).
