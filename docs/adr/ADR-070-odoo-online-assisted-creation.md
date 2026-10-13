# ADR-070: Creating an Odoo Online database is assisted, not automated

Status: Accepted (2026-10-13)

Relates to: ADR-028 (execution adapters), ADR-052 (which rejects headless
browsers), ADR-056 (module selection at project creation), ADR-064 (Odoo Online
records), ADR-068 (Odoo Online model creation).

## Context
 
The Create-with-AI flow produces an `ai_project`: Cartenz provisions a real Odoo
instance on this host (ADR-039) and the agent works against its repository.
Operators asked for the same starting point on **Odoo Online** — the SaaS at
odoo.com — and, later, Odoo.sh.

Odoo Online has no provisioning API. A database is created through the signup
form at `https://www.odoo.com/trial`. That form is protected:

- a hidden `csrf_token` and a hidden **`grc3_token`** (a reCAPTCHA v3 token);
- **Cloudflare Turnstile** (`turnstile_site_key` in the page's session info);
- required fields `username`, `company_name`, `db_name` (with an availability
  check), `email`, `phone`, `country_id`, and the app checkboxes.

A submit without a valid CAPTCHA token is refused. Automating the form headlessly
means defeating reCAPTCHA v3 and Turnstile — controls built precisely to stop a
script — which is brittle (it breaks whenever odoo.com changes), risks the
operator's Odoo account, and is against the spirit of those controls. This
platform already declined a headless browser for a lesser reason (ADR-052 §9).

Notably, the form asks for **no password**: Odoo emails the admin a link to set
one. So there is no admin credential for Cartenz to generate or hold.

## Decision

Creating an Odoo Online project is an **assisted** step. Cartenz collects the
signup plan and records the project; the operator completes the signup at
odoo.com; Cartenz connects the finished instance.

### 1. The Create-with-AI form chooses where the project runs

`CreateAiProjectDto` gains `hosting` (`on_host` default, or `odoo_online`) and,
for Odoo Online, an `odooOnline` block: `companyName`, `adminEmail`,
`subdomain`, `countryCode`, `apps[]`. `on_host` is the absence of a choice and
keeps today's provisioning path exactly. `odoo_sh` is a planned value that is
not yet accepted.

### 2. An `odoo_online` creation provisions nothing

`ProjectsService.createAiProject` branches on `hosting` before it does anything
else. The `odoo_online` branch writes one `projects` row (`projectType:
'odoo_online'`, `provisioning_status: 'none'`), the signup plan in the existing
`environment_config` JSON, one development environment, and the project's
specification — then returns. It never scaffolds a directory, never calls a
provisioning script, and never creates a GitHub repository. There is nothing on
this host to run.

The plan lives in `environment_config.signup`, so **no migration is needed** and
the portal already receives it. None of it is a secret.

### 3. The portal shows the plan and takes the API key

The project page renders a setup panel while an `odoo_online` project has no
`odoo_api` connection: the plan as a copyable checklist, a link to
odoo.com/trial, the steps (create, verify, generate an API key), and a small
form for the instance URL, the login and the API key. The link carries the
chosen apps as `?selected_app=<a:b:c>` — the query parameter Odoo's own trial
page reads (its "Odoo Sign" upsell opens the form that way) — so the boxes are
pre-ticked there and a person does not tick the same ones twice. Nothing else
can be carried: the form is submitted with a `grc3_token` minted by reCAPTCHA v3
in the browser, so it cannot be posted from Cartenz. Connecting reuses the
existing path — `POST /projects/:id/connections` with `connectionType:
'odoo_api'`, verified by a real authentication call in
`verifiedOdooOnlineMetadata` — after which the ordinary Odoo Online overview
takes over. A wrong key is a message on the panel, not a task that fails later.

### 4. No browser automation is introduced

No Playwright, Puppeteer or other headless browser is added, for the reasons in
Context. The operator's own browser solves the CAPTCHA; Cartenz does everything
that can be done without one.

## Consequences

- Creating an Odoo Online project is quick and never blocks on odoo.com: it is
  recording a plan, not making a network call to odoo.com.
- Provisioning stays host-side and untouched; the new branch cannot affect an
  on-host project.
- Nothing about the signup is enforced against odoo.com (odoo.com decides
  availability), so the checklist is a memory aid, not a binding contract. If
  the operator deviates there, the connection still verifies against whatever
  instance they actually created.
- External API access is plan-gated by Odoo (not available on One App Free or
  Standard plans). A trial that refuses an API key surfaces that as a clear
  message at connect time; the panel says so up front.
- Odoo.sh is not covered. Its provisioning is repository-based and also has no
  public API; it will follow the same assisted shape when it is built.
  Superseded for Odoo.sh by ADR-071.

## Verification

- Unit: `CreateAiProjectDto` accepts an `odoo_online` signup and refuses an
  unoffered `hosting`, a bad subdomain, a bad app name and a bad email
  (`odoo-online-hosting.dto.spec.ts`).
- Unit: the portal's app catalog helpers slug, address and group correctly
  (`frontend/lib/odoo-online-apps.test.ts`).
- Manual: create a project with hosting "Odoo Online"; the project page shows
  the checklist and the signup link. Complete the signup at odoo.com, generate
  an API key, paste it — the connection verifies and the overview appears with
  the right URL and database. An `on_host` project still provisions as before.

## Retirement condition

Retire this assisted path if Odoo publishes a supported API to create an Odoo
Online database; the signup plan and the connection step would then feed a real
provisioning call instead of a checklist.
