# ADR-090: The in-portal browser reaches anything the signed-in session can

- Status: Accepted
- Date: 3 November 2026
- Milestone: Phase 5 (connected-server estate)
- Supersedes: ADR-087 Option B's URL deny-list

## Context

ADR-087 chose Option B for the in-portal Odoo Online browser: a person signs
in themselves, the agent drives that session, and a URL deny-list
(`browser-policy.ts`) refuses the agent on Settings, Technical, Users, the
database manager and any URL carrying `debug=`. The operator's instruction at
the time was explicit:

> "Browser-driven agent TANPA guardrail (agent full kontrol UI Odoo, risiko
> sudah dijelaskan di atas)" - i.e. no guardrail, full control.

What shipped on `main` was Option B, which **is** a guardrail - a narrower
one than Option A (full, unguarded control) but a guardrail nonetheless. This
mismatch went unnoticed until it produced a concrete failure: a task asking
the agent to build an Automation Rule on `sale.order` failed with "changed
nothing", because Odoo's own navigation to Technical > Automation Rules
collapses to a bare `/odoo/settings` URL - a path the deny-list refused
outright, with no way to distinguish "Automation Rules" from "Users" at the
URL level once that collapse happens. Odoo's Automation Rules menu is itself
gated behind Developer Mode (`?debug=1`), which the same deny-list also
refused, so no URL-based carve-out for Automation Rules alone could have
worked without reaching into other debug-mode screens.

Presented with that root cause and the original "no guardrail" instruction,
the operator was asked once more, explicitly, which direction to take
(cabut guardrail sepenuhnya / buka pengecualian terbatas / pakai RPC tool
baru). The answer: **cabut guardrail Settings/Technical/debug mode
sepenuhnya - agent bisa akses apapun yang user login itu bisa akses,
termasuk Users/Database Manager (risiko penuh, sesuai permintaan awal
Anda)**.

## Decision

`browser-policy.ts`'s `AGENT_BLOCKED_FRAGMENTS` list and the screen-level
refusal in `agentUrlRefusal` are removed. The function now refuses a URL for
exactly one reason: it is not on the project's own Odoo Online host. Within
that host, the agent may navigate to, click on, and type into anything the
signed-in session can reach - Settings, Technical, Users, Groups, the
database manager, and any screen Developer Mode exposes. This is Option C in
ADR-087's framing: full access within the host boundary, not a subset of
screens within it.

What is unchanged from ADR-087:

- The host boundary itself (`isAllowedUrl`/`agentUrlRefusal`'s one remaining
  check) - the session still never loads a page outside the project's own
  Odoo Online host (plus `www.odoo.com`/`accounts.odoo.com` for sign-in,
  plus Odoo's own CDN), so this is not a general web proxy from this server.
- `browser_control` is still a separate, default-off project permission
  (ADR-087) - nothing here makes browser driving available by default.
- A person still signs in themselves; Cartenz still holds no Odoo password
  at rest; the session still ends on close, 30 minutes idle, or an API
  restart.
- A person still watches the live 1fps view while the agent works in it -
  nothing here changes the session from login-and-stay to login-then-leave,
  and the person watching remains the only check on what the agent does once
  inside.
- Everything ADR-087 already named as not holding for a browser-driven
  session - the record surface's deny-list, its per-call caps, its
  per-action approval - still does not hold here either; this ADR removes
  the one narrower guarantee (the URL deny-list) that Option B had added on
  top of that already-reduced baseline.

## Consequences

- The agent can now complete the kind of request that motivated this
  change: navigate to Technical > Automation Rules (even behind Developer
  Mode), read and set up a Server Action's trigger and domain, and - if the
  model chooses to, and the person watching allows it to continue - write
  the Python body of a Server Action directly against the live instance.
  There is no approval gate on that specific action beyond the person
  watching the session; the session itself remains something the person
  must have explicitly opened, but nothing stops the agent partway through
  the way the deny-list previously did.
- Equally, the agent can now reach Users, Groups, Access Rights and the
  database manager within the project's own host. A prompt that - by
  mistake, misunderstanding, or the model's own initiative - leads there can
  change who has access to the instance, or reach the database manager,
  with no platform-level refusal standing between the prompt and the
  action. The person watching the live session is the only mitigation left
  for this category, and ADR-087 already named watching as the given
  safeguard for a browser-driven session; this ADR removes the belt that
  used to sit alongside that brace.
- This instance (Katoka, the project this change was diagnosed against) is
  production, not a sandbox the operator can throw away. Every consequence
  above applies to live data and a live user base from the moment this ships.
- The deny-list's debug-mode refusal is gone along with the rest of it:
  Developer Mode screens (the raw field/view editor, the technical menu,
  server logs) are reachable to a driven session exactly as they are to the
  person who opened it.

## What was deliberately not built instead

A tool-based alternative was proposed and rejected by the operator: a new
RPC tool (`odoo_create_automation_rule`, parallel to `odoo_create_field`/
`odoo_create_model`) that would write directly to `base.automation` and
`ir.actions.server` through the existing API surface, keeping Python code
behind its own approval, without depending on the UI or Developer Mode at
all. That path remains available to build later if the operator wants
Automation Rules to work through the validated record surface (with its
deny-list, caps and approval gate) instead of through an unguarded browser
session; it is recorded here so the option is not lost, not because it was
judged worse on the merits.

## Testing

- `browser-policy.spec.ts`: rewritten from "refuses the agent on \[list of
  blocked screens\]" to "allows the agent on its own host at \[the same
  list, plus the Automation Rules URL that motivated this change\]". A new
  case confirms a different host is still refused regardless of path.
