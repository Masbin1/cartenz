# ADR-087: Browser-driven (RPA) control of a live Odoo instance

- Status: Accepted — Option B, then superseded by ADR-090 (3 November 2026; see "Decision")
- Date: 27 October 2026
- Milestone: Phase 5 (connected-server estate) / Phase 6 candidate
- Superseded by: ADR-090, for open question 4 (the URL deny-list below).
  Every other answer on this page (permission, approval shape, host, credential,
  alongside-not-instead, login-and-stay) is unchanged by ADR-090.
- Supersedes, for the scope defined here: the data-blind and record-surface
  posture of ADR-028, ADR-064, ADR-075, ADR-086 wherever this ADR's tool is
  used instead of theirs

## Context

Every record capability Cartenz has today — `odoo_search_records`,
`odoo_aggregate_records`, `odoo_create_records`, `odoo_update_records`, on
both `odoo_online` (ADR-064/084/086) and `on_premise` (ADR-075) — is RPC: a
structured call (`search_read`, `read_group`, `create`, `write`) validated
against a fixed method list and a protected-model deny-list before it ever
leaves the platform, capped in size, and gated by an approval that names the
exact model and values involved.

The request behind this ADR is different in kind, not degree: give the agent
a real browser, logged into the Odoo instance as a real user, and let it
carry out a prompt by clicking and typing in the UI directly — "jadi udah
langsung login kan, jadi ga perlu RPC lagi, jatuhnya itu kaya RPA gitu." The
stated motivation is capability: the UI can do things no RPC tool here
exposes today (Server Actions, Automated Actions, Studio screens, approval
workflows, report/dashboard building, bulk UI operations) without writing a
new validated tool for each one.

This ADR records what that trade actually costs, states the parts that are
blocked on infrastructure regardless of the decision, and lays out the
narrowest version of the capability if it is approved — so the choice being
made is explicit rather than discovered after something breaks.

### What "no RPC" actually means

Every click submits an HTTP request to the same endpoints the RPC tools call
today (`/web/dataset/call_kw`, under the hood the same ORM methods). The UI
is not a different transport; it is a different *author* of the same
request. "No RPC" does not mean the request stops being RPC — it means
nothing on the Cartenz side validates the request's shape, model, field
count, or record count before it is sent, because the request was composed
by a rendered page the agent is driving, not by a function this platform
wrote. Framing this as "skip RPC" undersells what is being given up: it is
"skip every check this platform currently performs on a write."

## What is lost, concretely, item by item

Each of these is a control that exists today, named by the file that
implements it, and what breaks without it:

1. **The protected-model deny-list** (`PROTECTED_PREFIXES` /
   `odoo_record_policy.py`). Today, a request naming `res.users`, `ir.model`,
   `ir.ui.view`, `res.config.settings` or any of the dozen other protected
   prefixes is refused before it reaches the network, on both executors,
   independently of the permission. In a browser, "refuse before it reaches
   the network" has no equivalent: Settings → Users, Settings → Technical,
   and every `ir.*` screen are just pages the agent can navigate to and
   submit a form on, the same as any other page. There is no check this ADR
   can propose that intercepts a UI form submission before Odoo accepts it,
   short of the agent choosing not to go there — which is a prompt
   instruction, not a control.

2. **The method allow-list** (`RECORD_METHODS` = search_read, search_count,
   read_group, create, write — no `unlink`, no `execute`). The "Delete"
   button exists in the Odoo UI for any model a user's groups can delete on.
   A browser-driven agent that can open a list view can select rows and
   click Delete; there is no tool-layer gate between "the agent is in a
   browser" and "the agent clicked a button Odoo rendered."

3. **The per-call caps** (`MAX_RECORDS_PER_WRITE` = 50,
   `MAX_RECORDS_PER_READ` / `MAX_GROUPS_PER_AGGREGATE` = 2000 / 1000). These
   bound what one tool call can do. A browser has no call boundary of this
   kind: "select all" in a list view, followed by a bulk action, operates on
   however many records the filter matched — 50, 5,000, or every row in the
   table.

4. **Precise, inspectable approval.** Today, `database_record_write`'s
   approval shows a person the exact model, the exact field values, the
   exact ids (ADR-064 §4, ADR-075 §5) — the review is of the *data*, before
   it is sent. A browser session cannot be decomposed into that shape ahead
   of time: the only approval that can precede a browsing session is "may
   the agent operate this browser for this task," which approves a capacity,
   not an action. Chapter 11's whole design (approve the instance of the
   action, not the actor) does not have an equivalent here.

5. **Read-only being free of consequence.** `odoo_search_records` needs no
   approval today because a read cannot be undone-from (ADR-064 §4: "reading
   is not the boundary chapter 12 was written to gate"). A browser session
   is not separable into "the read part" and "the write part" in advance —
   the agent could search, then click Create, inside the same session,
   crossing from free to consequential without a gate in between.

6. **"There is no shell"** (README §3, and now `/why-cartenz`, published
   this session, which states this as a *reason to choose Cartenz over a
   generic coding agent*). A browser the agent fully drives, with no
   per-action validation, is functionally a GUI shell: it can reach anything
   a human user with the same Odoo login could reach, which is usually
   everything an admin API key can reach. The platform's current
   differentiator — "Cartenz cannot run anything that is not on [a fixed
   list of mediated tools]" — stops being true for whatever this tool
   touches.

None of the above is a flaw in a specific design choice that a cleverer
implementation fixes. They are properties of "the agent drives a general
browser session" as a category: the control surface Cartenz relies on today
is the *boundary between the agent's intent and the request that is sent*,
and a browser session the agent drives directly removes that boundary by
construction, not by oversight.

## What is blocked on infrastructure, independent of the policy decision

Even setting every control question aside, two things must be true before
this can run anywhere, and neither is true on this host today:

### 1. Memory

This host (`Linkederp`) measured at the time of this ADR:

```
Mem:   3.8Gi total, 2.3Gi used,  115Mi free, 1.1Gi available (incl. reclaimable cache)
Swap:  2.0Gi total, 1.2Gi used
```

115 MB genuinely free, with the system already 1.2 GB into swap — a sign of
sustained memory pressure before anything new is added. A single headless
Chromium instance costs 200–500 MB; this host already runs `cartenz-api`,
`cartenz-worker`, `cartenz-portal`, PostgreSQL, and every provisioned Odoo
project's own instance (each itself several hundred MB to over a gigabyte).
Starting even one browser here risks the kernel's OOM killer choosing a
victim process — which could as easily be a customer's live Odoo instance as
the browser itself. This is not a tuning problem solvable by a smaller
Chromium flag set; the host does not have the headroom today.

Before this is viable at all, one of:

- The host's RAM is increased (how much depends on expected concurrency —
  see "Open questions" below);
- Browser automation runs on a separate host/VM, with Cartenz's backend
  connecting to it over a remote browser protocol (e.g. a CDP endpoint)
  rather than spawning Chromium locally;
- Or a hard concurrency cap (one browser session platform-wide, queued) is
  accepted as a permanent constraint, with monitoring that refuses a new
  session rather than letting the host degrade.

### 2. Login credential

The JSON-RPC API key Cartenz already stores (`projectConnections.secretRef`,
used by `OdooOnlineClient`) authenticates `execute_kw`, not the web login
form. Most Odoo deployments' `/web/login` wants the account's actual
password. Logging a browser in therefore needs a *new* secret Cartenz does
not hold today: the account's real password, or a password-equivalent the
instance accepts in its place (e.g. Odoo's "Log in as" impersonation URL, if
available and if the API key holder has rights to mint one).

Storing a real Odoo login password is a materially larger secret than an API
key: an API key can be scoped and revoked without touching anyone's personal
login; a stored password is either a shared service-account password (an
operational burden the client now owns) or literally the credential of a
real person's account, sitting in Cartenz's secrets store. Either way, this
is a new category of secret the platform's current `SecretsProvider`
envelope-encryption design was not reviewed against, and the answer should
be decided before a field for it is added — not discovered by whichever
column shape a provisional implementation happens to pick.

## What would need to exist if this is approved

Stated for completeness, not as a commitment — this is the shape, not a plan
to build it:

- **New credential**: a `browser_login` connection metadata shape
  (username + password, or an impersonation-token mechanism), sealed through
  the existing `SecretsProvider`, separate from the `odoo_api` connection.
- **New executor**: a browser-automation adapter (Playwright is the
  project's own existing reference — see `autonomous-ai-agents:computer-use`
  skill, `browser_exec_ide` tooling used elsewhere in this environment) that
  launches/attaches a browser, authenticates, and exposes a small set of
  primitives to the agent — navigate, click, type, read page text/DOM,
  screenshot.
- **New permission and mode**: this cannot reuse `database_record_read` /
  `database_record_write`, because those permissions' entire meaning today
  is "bounded by the record surface." A new permission (e.g.
  `browser_control`) makes the capability's different risk legible in
  project settings, defaulting to `false` like every other sensitive
  permission, and not silently inherited by a project that granted the
  existing record permissions under the old, narrower meaning.
- **Approval, narrowed to what can be shown**: realistically, approval of
  the *session* ("agent may operate the Odoo UI for this task"), shown
  alongside the live task transcript/screenshots as the only way a person
  can meaningfully review what happened — after the fact, not before, for
  anything beyond the initial grant.
- **An audit trail built for this**: today's audit log records a tool call
  with its validated arguments. A browser session's audit trail would need
  to be a recording — screenshots or a DOM action log per step — because
  there is no structured argument list to log otherwise.
- **An explicit statement that `/why-cartenz` and the README's safety
  section no longer describe this capability truthfully**, scoped to
  whichever mode/project enables it; either carve out an explicit exception
  in that copy or decide the tradeoff is not worth making.

## A refined mechanism: human logs in, agent drives the authenticated session

A later round of this discussion named a more precise mechanism than "the
agent logs in automatically": a browser panel inside Cartenz where a person
pastes the project's URL, logs in **themselves** (this is exactly the pattern
this environment's own `browser_exec_ide` / `browser_vault_fill_ide` tools
use — a human-driven login step, then the agent drives the already
-authenticated session). This is a real, different, better-precedented
design than "store the Odoo password and let the agent authenticate," and it
resolves the infrastructure blocker in §2 above cleanly: **Cartenz never
holds the Odoo password at all.** The person's own credential, typed by
them into the real Odoo login form, is what authenticates — nothing new to
seal in `SecretsProvider`, nothing new for an operator to rotate if someone
leaves.

What this does **not** change is almost everything in "What is lost,
concretely" above. Once a session is authenticated, whether the agent
reached that state by typing a stored password or by taking over a session a
person logged into themselves, the agent can navigate anywhere that login
can reach: items 1–3 (deny-list, method allow-list, per-call caps) and item
6 (no shell) apply identically either way — the browser does not know or
care who typed the password. Items 4–5 (precise approval, free reads) are
*slightly* softer here only in the sense that a human watched the login
happen; nothing says a human watches what the agent does with the session
afterward, and the same "approve the session, not the action" shape from the
main proposal still applies unless a person is made to stay present for
every step (see the open question below).

So this mechanism is strictly worth preferring over a stored password **if**
Option B or C is chosen — it removes one of the two infrastructure blockers
outright — but it does not by itself make Option B/C a smaller policy
decision than the rest of this document already describes. It is a better
*answer to open question 3*, not a reason to skip open questions 1, 4 and 5.

It also raises a new question of its own, since the login step and the
agent's work are not necessarily the same moment:

- **Login-then-leave**: the person logs in, closes the tab, and the agent
  continues later against the same session (a stored cookie/session token on
  the server). This needs the session artifact itself treated as a secret —
  materially the same custody problem as a stored password, just a
  different-shaped value with its own expiry.
- **Login-and-stay**: the person remains present for the whole task, the
  session never outlives their own tab. This has no new secret-custody
  problem, but it means the capability requires a human available for the
  full duration of every task that uses it — which is a real constraint on
  when and how it can be used, not a detail to leave implicit.

Which of these two is intended changes whether this mechanism actually
avoids introducing a new stored secret, or just changes its shape from
"password" to "session token" — worth answering explicitly alongside the
open questions below (added as open question 6).

## Options

**A. Do not build this.** Keep the RPC surface (ADR-064/075/084/086) as the
only way an agent touches Odoo data, and close capability gaps (Automated
Actions, Server Actions, Studio screens) one validated tool at a time, as
ADR-075/086 themselves were — each a reviewed, bounded addition rather than
an open-ended one. This is the only option that keeps every guarantee in the
README's §3 and `/why-cartenz` true without qualification.

**B. Build it, scoped to a single pilot project, human-supervised.** The
browser session requires a person to click "start" and watch, is never
unattended, every session is recorded, and `browser_control` is granted to
exactly one project chosen for the trial. This tests the capability's actual
usefulness and failure modes before any decision about wider rollout, and
keeps the blast radius to one client's data even in the worst case.

**C. Build it as a general capability.** Full scope as sketched above,
available to any project an admin opts in, unattended. This is what "no RPC,
just prompt it" implies taken literally, and it is the option that costs the
most of what §"What is lost" describes, with the least ability to bound the
damage of a single bad session.

This ADR takes no position between A/B/C; that choice is the thing being put
to review.

## Open questions for the reviewer

1. Which option (A/B/C), or something between B and C (e.g. "pilot projects
   only, always human-supervised, indefinitely" rather than B as a
   time-boxed trial)?
2. If B or C: upgrade this host's RAM, run browser automation on a separate
   host, or accept a hard one-session-at-a-time cap? (See "Infrastructure
   blockers" above — this has to be answered before any code runs, not
   after.)
3. If B or C: is a shared service-account Odoo password acceptable, or must
   this be a real user's login per project? Who owns rotating it if an
   employee with that login leaves?
4. If B or C: what, specifically, must the agent be refused even inside an
   approved browser session — is "nothing, it's a login" the actual answer,
   or are there pages (Settings → Users, Settings → Technical, Database
   Manager) that should be refused even here, enforced by blocking
   navigation to known-dangerous URLs rather than relying on the prompt?
5. Does this run instead of the RPC tools, or alongside them (agent chooses
   per task)? Running alongside means every guarantee the RPC tools provide
   is now optional per task, which is worth naming explicitly rather than
   assuming.
6. For the human-login mechanism above: login-then-leave (a session token is
   stored server-side and is itself a secret needing custody and expiry), or
   login-and-stay (a person must remain present for the whole task)? These
   have different infrastructure and different constraints on when the
   capability can be used — the choice should be explicit, not left to
   whichever an initial implementation happens to default to.

## Retirement condition

This ADR is retired into either "Accepted" (with option and open questions
answered) or "Rejected" (Option A stands, this document stands as the record
of why) — it should not stay "Proposed" indefinitely once reviewed.

## Decision (2 November 2026)

Option B, scoped to the `odoo_online` execution mode. Odoo.sh and on-premise
projects keep the existing surface (ADR-064/075/084/086) unchanged.

Answers to the open questions:

1. **Option**: B — human-supervised, per project, opted in.
2. **Infrastructure**: Chromium runs on this host, behind a server flag
   (`BROWSER_SESSIONS_ENABLED`, default false) and a hard cap of two open
   sessions platform-wide. This host now measures 6.6 GiB with ~5 GiB
   available; revisit (separate host over CDP) before raising the cap.
3. **Credential**: neither a shared nor a personal password is stored. The
   person signs in to Odoo themselves inside the panel; keystrokes pass through
   to the page and are not recorded.
4. **Refused even inside a session** (`browser-policy.ts`, enforced by URL
   before and after every agent action): `/web/database`, `res.users`,
   `res.groups`, `res.config.settings`, any `ir.*` model, `base.module`,
   `/odoo/settings`, and debug mode. Every request the page makes is held to the
   project's own host and Odoo's sign-in hosts; anything else is aborted.
   **Superseded by ADR-090 (3 November 2026): this screen-level deny-list was
   removed.** Automation Rules - which this list blocked as a side effect of
   blocking `/odoo/settings`, since Odoo collapses the Automation Rules URL to
   that same bare path - is what surfaced the problem; the operator's answer,
   given the choice again, was to remove the deny-list entirely rather than
   carve out an exception. Only the host-boundary check from the next line
   remains.
5. **Alongside, not instead of**, the RPC tools. The agent is instructed to
   prefer the record and schema tools and use the browser only for what only
   the UI does.
6. **Login-and-stay.** The profile (cookies included) is a temporary directory
   deleted when the person closes the session, after 30 idle minutes, or when
   the API process stops. No session artifact outlives the person.

Shape as built:

- Permission `browser_control`, default false, approval-bearing, not
  inherited from the record permissions.
- Approval action `browser_session`: one grant per task before the first
  `browser_click` / `browser_type`; `browser_snapshot` and `browser_navigate`
  need no approval. A change task's approved plan stands in for it, as it does
  for `odoo_record_write`.
- Tools act only on refs from the agent's own latest accessibility snapshot,
  never on raw selectors or coordinates.
- The audit trail is the existing per-tool action log (each action's ref, text
  and resulting URL/snapshot). Screenshot recording is not built; add it if a
  reviewer needs a visual record.
- The README §3 and `/why-cartenz` "there is no shell" statements are not yet
  qualified for this capability; that copy change is outstanding.
