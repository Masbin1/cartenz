# ADR-040: A provisioned instance gets HTTPS, and its master password is sealed rather than shown

- Status: Accepted
- Date: 11 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Builds on ADR-039 (provisioning via the operator's scripts), ADR-014 (the secrets
provider) and ADR-024 (permanent deletion destroys sealed secrets).

## Context

ADR-039 makes a created project a running Odoo instance. Two things were left
unfinished, and both are about what the person who created it receives.

**The address was plain HTTP.** A provisioned project came back as
`http://<name>.<domain>`, which is not somewhere anyone should sign into. The host
already runs Nginx with a site per project, and `certbot --nginx` is the ordinary
way to put a certificate on one — but it is a root action, and running it against
an arbitrary caller-supplied domain would let a project name decide which host's
certificate gets reissued.

**`create_project` prints a master password.** The Odoo master password for the new
instance is real, it is needed, and it appeared on the provisioning script's
standard output — inside the platform's process, in a command result, on its way
into a log. The platform's whole posture is that nothing outside
`backend/src/core/secrets/` holds a plaintext credential, and a password the
platform reads and then forgets to seal is exactly the failure ADR-014 exists to
prevent. The person who created the project still has to be able to get it.

## Decision

### 1. HTTPS is issued for the project's own domain, and only for that

`setup-project-https.sh` runs `certbot --nginx` non-interactively for a provisioned
project, using the operator's configured `PROJECT_HTTPS_EMAIL`. **It refuses any
domain that is not already the `server_name` of that project's own Nginx site.**
The domain is therefore not something a caller chooses; it is something the host
already believes about that project, and the script's job is to confirm it rather
than accept it.

It is a fourth fixed shape under the existing `sudo` entry of ADR-039 — recognised
by `assertProvisioningInvocation`, named in the same sudoers `Cmnd_Alias` — not a
new executable and not a new grant. Root must reinstall that file for issuance to
run at all.

### 2. Off by default, and a misconfiguration is refused at boot

`PROJECT_HTTPS_ENABLED` defaults to false and is refused at the process chokepoint
the same way `PROJECT_PROVISIONING_ENABLED` is. Enabling it without provisioning,
without a domain, or without an email is refused **at boot**, not at first use: a
deployment that is going to fail should fail while someone is watching it start,
not when a customer creates their first project.

### 3. A certificate failure degrades to HTTP; it does not fail the project

Issuance runs immediately after a successful `create_project`. On success the
recorded URL is upgraded to `https`. On failure the project stands on plain HTTP,
with the failure recorded in `https_status` and `https_error`. A certificate is an
improvement to a working instance, and losing the instance because the certificate
authority was rate-limiting would be the wrong trade.

### 4. The master password is sealed on arrival and returned by no ordinary endpoint

The provisioning service parses the password from the script's output; the projects
service seals it through `SecretsProvider` immediately and discards the plaintext
from its own scope. It is stored as a `secret_records` reference
(`provisioning_master_password_ref`), never as a value on the project row.

`findOne` carries neither the plaintext nor the reference — only a
`hasMasterPassword` boolean, so the portal can show a reveal control without the
response shape having a field that could ever carry the secret. Revealing it is a
separate, deliberate act: `GET /projects/:id/provisioning-secret`, admin or owner
only, audited as `project.master_password_revealed`.

### 5. Deletion destroys it by reference

The password is sealed while the project row does not yet exist, so it is sealed
with `projectId` null — and ADR-024's permanent-delete cleanup destroys secrets
*by project*, which would have walked straight past it and left a live Odoo master
password encrypted in the database, owned by nothing. `destroy()` now also destroys
it by its stored reference.

## Consequences

- A provisioned project is handed over as an `https` address with a certificate for
  its own domain, or as plain HTTP with the reason recorded — never as a silent
  half-state.
- No project name can cause a certificate to be issued for a domain the host does
  not already serve for that project.
- The master password exists in plaintext only inside the secrets provider and in
  the response to one audited, role-restricted endpoint. It is not in `findOne`, not
  in the project row, and not in the audit trail.
- Deleting a project destroys it. This was a real leak, found while building the
  panel rather than after shipping it, and it is the second time (ADR-024 was the
  first) that `secret_records` having no foreign key by design required the delete
  path to be told explicitly what to destroy.
- HTTPS issuance, like provisioning, is an operator-enabled feature whose enabling
  step is a root action on the host.

## Verification

- Unit: `assertProvisioningInvocation` accepts the HTTPS shape and refuses a script
  path, domain or email that was not configured; boot validation refuses
  `PROJECT_HTTPS_ENABLED=true` without provisioning, a domain or an email.
- Unit: `findOne`'s response shape carries no secret reference and no plaintext.
- Migration: `0012_project_instance_credentials` adds
  `provisioning_database_name`, `provisioning_master_password_ref`, `https_status`
  and `https_error`; applied against the live database and the four columns
  confirmed.
- End-to-end: a provisioned project shows its URL, database, HTTPS status and
  provisioned-at in the portal's Instance panel; the reveal control returns the
  password to an owner and writes `project.master_password_revealed`; a permanent
  delete leaves no `secret_records` row behind.
