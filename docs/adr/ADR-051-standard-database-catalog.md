# ADR-051: A standard-database catalog for AI-safe instances

- Status: Accepted
- Date: 17 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-044 (regions), ADR-045 (version catalog and template databases),
ADR-050 (repo-backed connected projects).

## Context

A task that involves the AI needs an Odoo database to run against for validation and,
later, for a UI preview. The obvious source — the customer's database — is the one
source that must not be used: it holds customer records, and the whole point of the
data-sovereignty posture is that customer data does not reach a model or a
platform-hosted instance used for AI work.

The operator already maintains **standard databases** of LinkedERP's own making, one
per edition and region, and wants them used wherever an AI-bearing instance needs a
database. A customer who supplies an example database still gets a manual restore,
separately.

## Decision

### 1. A dedicated catalog folder, tracked in git

`database/` at the repository root holds the standard archives. They are LinkedERP's
own baselines, never client data, and they are **committed with git**. Each archive is
Odoo's own backup format: a `dump.sql` plus a `filestore/`, zipped.

`database/manifest.json` is the authoritative catalog. The file name is a convention;
the manifest is what a resolver reads, because the first six files were supplied with
mixed separators and no version.

### 2. One artifact per edition, region and series

```
linkederp-standard-<edition>-<region>-v<major>.zip
linkederp-standard-enterprise-indonesia-v19.zip
linkederp-standard-ce-south-africa-v18.zip
```

The version is required: a standard database for `19.0` cannot be restored into
`17.0`, and the catalog holds several series per region. `v19` is the series `19.0`.
**A project resolves to exactly one artifact by version + edition + region** — an
Odoo 19, Enterprise, Indonesia project gets
`linkederp-standard-enterprise-indonesia-v19.zip` and nothing else. `region` is
normalised so `USER_REGIONS`' `south_africa` and the file name's `south-africa` resolve
to the same thing.

### 3. The zip builds a host template; projects clone it

This extends ADR-045 rather than replacing it:

1. The zip is restored **once** on the host into a template database,
   `cartenz_tpl_<version>_<edition>_<region>`, and neutralised.
2. A project's database is a fast `CREATE DATABASE ... TEMPLATE` clone of it, exactly
   as ADR-045 already does.

So the zip is the portable source of truth and the template is the host-local cache;
project creation stays a clone rather than a restore.

### 4. It applies to Cartenz-hosted instances

Full restore from the catalog applies to an instance Cartenz hosts: the preview
instance, the validation database, and the replica of ADR-050.

An **external Odoo.sh instance builds and owns its own database**; Cartenz cannot push
a zip into it, so there the standard database is used for local preview and validation
only.

### 5. A client database is a separate, manual action

If a customer provides an example database, restoring it is an explicit operator
action. It is never the database an AI task runs on, and it does not change the
default: AI-bearing work uses the standard catalog.

### 6. Restore is guarded

Restoring a zip is an operator action behind the same root/sudo boundary as
provisioning (ADR-039). It validates the archive (path traversal, absolute paths,
oversized entries), and after restore neutralises the clone: regenerate
`database.uuid`, set `web.base.url`, set the admin password per project, and scrub
stored credentials (mail servers, payment providers, API keys) before sealing the
template.

## Consequences

- AI testing, validation and preview never touch customer data: code comes from Git,
  the database comes from the catalog.
- A replica needs a matching artifact for its version, edition and region. A missing
  one fails loudly, as ADR-045 already does, rather than producing an empty database.
- The repository carries binary database archives. A full Enterprise database plus
  filestore can be hundreds of megabytes, and git keeps every version forever. The
  design is sound; the storage mechanism may need to move to Git LFS if the repository
  becomes unwieldy. That is a transport change, not a design change.
- Templates must be rebuilt when a standard database changes; projects already cloned
  from the old template are unaffected, exactly as ADR-045 states.

## Retirement condition

Retire if the platform gains a data-safe way to run against a customer database (for
example, a k-anonymised or synthesised copy produced from the customer's own data),
which would supersede a hand-maintained standard catalog.

## Verification

- `manifest.json` parses and every artifact names an edition, a region and a version;
  a resolver matches `south_africa`/`south-africa` alike.
- A host template built from an archive appears as `cartenz_tpl_<ver>_<edition>_<region>`
  with `datistemplate = true` and `datallowconn = false`.
- A project of that version/edition/region gets a clone whose `database.uuid` differs
  from the template's and whose module count matches a full installation.
- A missing artifact for a version/edition/region is refused with a clear message.
