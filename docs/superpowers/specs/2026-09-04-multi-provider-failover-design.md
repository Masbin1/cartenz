# Multi-provider model configuration with failover — design

**Status:** Draft · **Date:** 2026-09-04 · **Topic:** An ordered list of AI providers configured in the portal, tried in priority order, replacing the single-provider row

## Context

ADR-023 moved the model provider from the environment into the portal: `organization_model_settings`
holds one row per organisation, `/settings` edits it, `ModelProviderResolver` builds a provider from
it, and the environment remains the fallback when no row exists. That works and is not being
replaced.

Three things it does not do:

1. **One provider per organisation.** The table's primary key is `organization_id`, so there is
   nowhere to put a second. When a gateway is rate-limited or down, the task fails.
2. **Structured-output support is global.** `AI_STRUCTURED_OUTPUTS` is one environment value for the
   whole deployment, but DeepSeek rejects `response_format: json_schema` and the local gateway
   accepts it. The two cannot be configured at once, which is precisely what a fallback chain needs.
3. **A keyless loopback row fails misleadingly.** Verified on this host: three of four stored rows
   have `secret_ref = NULL`, and the resulting failure reads `openai-compatible rejected the API key`
   when in fact no key was ever stored.

### Verified on this host, 2026-09-04

| Check | Result |
| --- | --- |
| `GET http://127.0.0.1:20128/v1/models` | HTTP 200, 30+ models served |
| `POST /v1/chat/completions` with `response_format: json_schema`, model `Paket-Hemat` | `{"status": "OK"}` |
| Stored rows in `organization_model_settings` | 4 rows, 3 with `secret_ref = NULL` |
| Audit trail for the failing test | `{"ok": false, "error": "openai-compatible rejected the API key. The provider said: Invalid API key"}` |

The gateway, the model name and the structured-output path are all healthy. The failure is
configuration and code, not connectivity.

## Product decisions

Settled before design, and not revisited below:

1. **Failover, not round robin.** Providers are tried in priority order; number one is used until it
   fails. Not per-call rotation — that would let one task be answered by several models.
2. **Per organisation.** One ordered list for the whole organisation; every project uses it. No
   per-project override.
3. **The environment stays as the last resort.** An organisation with an empty list falls back to
   `AI_*` exactly as today, so existing deployments keep working and a fresh install runs before
   anyone logs in.
4. **Hermes in two phases.** Phase one — this spec — treats Hermes as what ADR-023 records it as: the
   local OpenAI-compatible gateway. Phase two, agentic per-project learning, gets its own spec.

## Approach

**Wrap the list in one `ModelProvider`.** `ModelProviderResolver` builds an ordered list and returns a
`FailoverModelProvider` that tries its members in turn, wrapped as always in `GuardedModelProvider`.

```
forOrganization(orgId) → GuardedModelProvider(
                           FailoverModelProvider([
                             AiSdkModelProvider(priority 1),
                             AiSdkModelProvider(priority 2),
                             AiSdkModelProvider(priority 3),
                           ]))
```

Callers do not change: `model-agent-planner.ts:92`, `:146` and `model-implementation-loop.ts:108`
each receive one `ModelProvider` and stay as they are.

**Rejected: failover in the orchestration layer.** The same retry loop would have to exist at all
three call sites, and every new call site would have to remember it.

**Rejected: a single `fallback_*` column pair.** Fewest lines, but capped at two providers and not
extensible without being torn out.

## Design

### 1. Schema

`organization_model_settings` becomes one row per provider. Migration `0005`, additive:

| Column | Status | Notes |
| --- | --- | --- |
| `id` | new | `uuid primary key default gen_random_uuid()` |
| `organization_id` | changed | No longer the primary key. Indexed with `priority` |
| `priority` | new | `integer not null`. Lower is tried first. Unique per organisation |
| `label` | new | `text`. Human name — "9router Paket-Hemat", "DeepSeek fallback" |
| `enabled` | new | `boolean not null default true`. Disable without discarding the key |
| `structured_outputs` | new | `boolean`. Null means "use the environment default" |
| `provider_id`, `model`, `base_url`, `secret_ref`, `revision`, `updated_by_user_id`, `created_at`, `updated_at` | unchanged | |

Existing rows get `priority = 1` and a `label` derived from `provider_id`, then the primary key
moves. The four rows on this host keep working with no manual editing.

**Cache invalidation.** `ModelProviderResolver` caches a built provider against `revision`
(`model-provider-resolver.ts:63-81`). With several rows the organisation-level number becomes
`sum(revision)`, which changes whenever any row is edited, added or removed. Not obvious on sight, so
it carries a comment.

### 2. Failover behaviour

**Which errors move on.** The classification in `ai-sdk-model-provider.ts:295-359` already
distinguishes these; what is new is only the move-on / stop decision.

| Condition | Existing message | Action | Why |
| --- | --- | --- | --- |
| 401 | `rejected the API key` | move on | This row's key is wrong; the next row has its own |
| 402 | `account has no credit remaining` | move on | This account only |
| 403 | `key was accepted but is not allowed to use <model>` | move on | Per-account entitlement |
| 404 | `has no model called "<model>", or the base URL is wrong` | move on | This row is misconfigured |
| 429 | `rate limited the request` | move on | The case the feature exists for |
| 5xx | `was unavailable` | move on | Endpoint down |
| Timeout | `TimeoutError` | move on | Endpoint hanging |
| 400 | `refused the request as malformed` | **stop** | The request is wrong, not the provider. Every provider would answer the same |
| `AiBoundaryRefusalError` | handled at `agent-workflow.ts:1128` | **stop** | A human decision. Must not be retried against another endpoint |
| Zod schema validation | — | **stop** | The provider answered but in the wrong shape — a `structured_outputs` problem on this row |

The boundary rule is the one that matters. `GuardedModelProvider` stays **outside** the failover
wrapper, so the boundary is crossed once for the whole chain and a refusal happens before any
provider is reached. `FailoverModelProvider` checks the error type first and rethrows
`AiBoundaryRefusalError` untouched.

**Stopping.** One pass through the list; a failed provider is not retried within a call. Disabled
rows are skipped without counting. When every row fails, the error reported is the **first
priority's**, with a one-line summary of the rest — "priority 1 rejected the key; 2 rate limited; 3
unavailable" — because the last provider's error is usually the least informative while the question
being asked is why the primary failed.

**No inter-attempt delay.** Exponential backoff already exists at the queue layer
(`queue-agent-orchestrator.ts:51`, `attempts: 3`). Adding it here would make a task wait twice.

**No cooldown.** A failed provider is not marked sick for the next call. Cooldown needs state shared
between worker processes, which means Redis, which means a subsystem for a problem not yet
demonstrated. The cost is one wasted call per model call while the primary is down — not per task,
since providers are built once and cached. The upgrade path (a Redis key with a TTL) goes in a
`ponytail:` comment.

**What is recorded.** `agent_model_calls` already carries `provider_id` and `model`
(`schema.ts:750-751`), so which provider actually answered is recorded with no schema change. One
existing bug is fixed alongside: the failure path at `agent-workflow.ts:1143` records
`this.config.ai.provider` — the environment value, not the provider actually used. Already wrong
today for portal-configured organisations, and worse with failover. Each switch is recorded in
`agent_actions` as one entry.

### 3. Test connection

**The defect.** Traced across three files:

| Step | File | What happens |
| --- | --- | --- |
| 1 | `model-settings.service.ts:91` | A stored row is found, `fromEnvironment = false` |
| 2 | `model-settings.service.ts:289-293` | `readApiKey()` returns `undefined` — `secretRef` is null and the environment is deliberately not consulted on this branch |
| 3 | `model-provider-resolver.ts:228` | An absent key is allowed because the base URL is loopback |
| 4 | `ai-sdk-model-provider.ts:96` | The placeholder `not-required-for-a-local-gateway` is substituted |
| 5 | 9router | Rejects it: `Invalid API key` |

The assumption at step 3 — a loopback gateway may have no key — is right for ollama and llama.cpp.
9router and Hermes **do** authenticate. The placeholder then travels silently until the gateway
rejects it, and the message reads like a wrong key when no key was ever stored.

**Fixes:**

- **Warn on save, not on failure.** A loopback row saved with no key is still accepted — ollama
  genuinely has none — but `write()` returns a warning the UI shows: *no key stored; local gateways
  like 9router and Hermes authenticate and will reject the request, ollama and llama.cpp will not*.
- **Distinguish the two failures.** `AiSdkModelProvider` knows when it substituted the placeholder,
  so a 401 in that case reads *this gateway rejected the request because no key is stored — the
  placeholder sent for local endpoints was refused. Enter a token in Settings.*
- **Test per row.** `POST /organizations/:id/model-providers/:rowId/test` tests one row;
  `POST /organizations/:id/model-providers/test` tests the whole chain and returns an array, so one
  click shows whether the fallbacks actually work. An untested fallback is not a fallback.
- **Result shape.** `ProviderTestResult` (`model-provider-resolver.ts:29-36`) gains `priority` and
  `label` so a result maps to its row.

**Unchanged:** the probe prompt (`model-provider-resolver.ts:147-158`, verified working against this
gateway), `CONNECTIVITY_SCHEMA` (structured on purpose — a provider that answers text but cannot
produce structured output would pass a text check and fail every task), returning failures rather
than throwing, and saving before testing so what is on screen is what is tested
(`frontend/app/settings/page.tsx:150-153`).

**Sequencing.** The defect is independent of multi-provider and breaks this installation today. It
ships **first, as its own commit** — roughly 15 lines across `model-settings.service.ts` and
`ai-sdk-model-provider.ts` — so test connection works before the larger work starts.

### 4. Settings UI

The current page (`frontend/app/settings/page.tsx`, 393 lines) is one form for one provider. It
becomes an ordered list, one form per row.

```
┌─ AI providers ───────────────────────────────────────────────────┐
│  Tried in order from the top. If one fails, the next is used.    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 1  9router Paket-Hemat           [enabled]  ↓ Test Remove│    │
│  │    openai-compatible · Paket-Hemat                       │    │
│  │    http://127.0.0.1:20128/v1 · key stored                │    │
│  │    ✓ Answered in 1,240 ms                                │    │
│  └──────────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 2  DeepSeek fallback          [enabled]  ↑ ↓ Test Remove │    │
│  │    openai-compatible · deepseek-chat                     │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  [ + Add provider ]                    [ Test the whole chain ]  │
│                                                                  │
│  With an empty list the server configuration is used:            │
│  openai-compatible / cc/claude-sonnet-5                          │
└──────────────────────────────────────────────────────────────────┘
```

- **Up/down buttons, not drag-and-drop.** Priority changes rarely; drag-and-drop needs a new
  dependency for what two buttons solve.
- **Rows are summaries, expanded to edit.** Three full forms at once is an unreadable page.
- **Test results attach to their row** — the reason `priority` and `label` joined the result shape.
- **The environment fallback is text, not an editable row.** It is not a database row, and rendering
  it as a fourth row would imply it can be deleted here.

**Presets** fill the form; they are not provider kinds. All still store as `openai-compatible`.

| Preset | Base URL | Model | `structured_outputs` |
| --- | --- | --- | --- |
| Local gateway (9router / Hermes) | `http://127.0.0.1:20128/v1` | from `/v1/models` | `true` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | `false` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `true` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `true` |
| Anthropic direct | — | `claude-sonnet-4-5` | `true` |

**One preset for 9router and Hermes, not two.** On this host they are the same process — ADR-023
records Hermes at `http://127.0.0.1:20128/v1`, and that is what served `Paket-Hemat` in the
verification above. Two entries with an identical URL would be misleading. If Hermes later runs on
its own port, a second preset is added then.

**Per-row `structured_outputs` is what makes the chain possible.** Global today via
`AI_STRUCTURED_OUTPUTS` (`configuration.ts:98-101`), but DeepSeek rejects `json_schema` and the local
gateway accepts it — both verified. Without the column, a 9router → DeepSeek chain cannot work.

**Model discovery.** For a row being edited, "Load models" calls
`POST /organizations/:id/model-providers/discover-models` with the base URL and optional key, and
turns the model field into a dropdown. The gateway serves 30+ models (`Paket-Hemat`, `Banyak-duit`,
`Deepseek`, `ag/claude-sonnet-4-6`) that nobody can guess, and a wrong name returns as HTTP 400 or
404, which `explain()` renders like a different problem. It runs through the backend because the
browser has no key and must not be given one.

**Permissions** are unchanged: `requireOrganizationMember` to read, `'admin'` to write
(`organizations.controller.ts:107`, `:117`). Non-admins see the list and its test results without the
edit controls, as at `frontend/app/settings/page.tsx:362-367`. Running a test stays admin-only
(`organizations.controller.ts:153`) because it spends tokens.

**Audit.** Existing events kept (`audit-events.ts:49-51`) with `priority` and `label` added to the
metadata, plus a new `model_provider.reordered` — priority decides which endpoint receives source
code first, so changing it belongs in the trail.

## Testing

- `FailoverModelProvider`: moves on for each listed condition, stops for 400, rethrows
  `AiBoundaryRefusalError` untouched, reports the first priority's error when all fail, skips
  disabled rows.
- `ModelSettingsService`: priority uniqueness, reordering, the keyless-loopback warning, and the
  existing key-handling assertions in `model-settings.spec.ts` kept green.
- Migration `0005`: an existing single row survives with `priority = 1` and a derived label.
- The placeholder-rejection message is distinct from a genuine 401.

## Out of scope

- Per-call round robin, weighting, cooldown.
- Per-project provider overrides.
- Hermes as an agentic learning service — phase two, its own spec.
- Odoo Online, which has no local code (see the local-execution-mode spec).
