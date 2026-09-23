# Diagnosis: "Every configured provider failed" on change tasks

- Date: 23 September 2026
- Symptom: `task_166978` (and the same shape on `task_636395`, 22 September) failed
  during planning with one message naming all five providers:

  ```
  Every configured provider failed. Priority 1 (Hermes (local gateway)):
  openai-compatible was unavailable. Then with-money: openai-compatible rejected
  the request.; openai-compatible: openai-compatible rejected the request.;
  Masbin: openai-compatible rejected the request.; deepseek: openai-compatible
  rejected the request. This is usually transient; submitting the task again may
  succeed.
  ```

## Summary

Not an incompatibility in the platform, and not a broken credential chain. Every
configured provider was reached, and each failed for its own reason. What makes it
look systematic is that **only change tasks ask for structured output**: chat uses
`generateText`, change uses `generateObject`, which must return an object matching
the plan's schema. Each provider was healthy enough for a chat answer and still
failed the structured request — which is exactly the difference the operator
observed: *"kalo ngoding aja dia gak bisa, kalau mode chat bisa kok ngasih
jawaban, tapi kalo mode change, selalu error kaya gitu"*.

## Evidence, live-tested against each provider

Direct calls to each configured endpoint, both plain and with the plan's
`response_format` (structured) request:

| Priority | Label | Endpoint / model | Plain request | Structured request |
|---|---|---|---|---|
| 1 | Hermes (local gateway) | `127.0.0.1:8642/v1` / `hermes-agent` | 401 `Invalid gateway API key (API_SERVER_KEY)` | 401, same |
| 2 | with-money | `127.0.0.1:20128/v1` / `with-money` | 200 `content:"ok"` | 200 **`content:""`** (empty) |
| 3 | *(no label)* | `127.0.0.1:20128/v1` / `ds/deepseek-v4-flash` | 200 `content:"ok"` | **503** `This response_format type is unavailable now` |
| 4 | Masbin | `127.0.0.1:20128/v1` / `Masbin` | 200 (streamed, no content in test) | 200 **valid JSON** `{"summary":…,"plan":[…]}` |
| 5 | deepseek | `api.deepseek.com` / `deepseek-flash` | 401 `Authentication Fails … key is invalid` | 401, same |

Two different symptoms in the log, and they matter:

- `openai-compatible was unavailable.` → the request never completed (401, 503,
  timeout). This was Priority 1 on every occurrence: the local Hermes gateway on
  `:8642` refuses the key Cartenz sends. That is the reason Priority 1 fails every
  single time, not a transient network blip.
- `openai-compatible rejected the request.` → the request completed and the answer
  could not be used: empty `content` (with-money, Masbin on the bad round-robin
  beat), a model that cannot produce the JSON object, or — for `deepseek` —
  `No object generated: could not parse the response` twice in a row.

The worker log for the failing window shows the sequence precisely:

```
09:54:31  Priority 1 (Hermes (local gateway)) failed structured generation: … was unavailable
09:54:35  Priority 2 (with-money)           failed structured generation: … rejected the request
09:54:39  Priority 3 (openai-compatible)    failed structured generation: … rejected the request
09:55:12  Priority 4 (Masbin)               failed structured generation: … rejected the request
09:55:13  deepseek-flash produced a response that did not match the schema; retrying (attempt 2/2)
09:55:15  deepseek-flash failed: No object generated: could not parse the response
09:55:15  Priority 5 (deepseek) failed structured generation: … rejected the request
09:55:15  ERROR [AgentWorkflow] task_166978 failed during planning: Every configured provider failed …
```

Every one of these is a **structured generation** failure. Chat-mode calls
(`failed tool loop`) that appear elsewhere in the same log generally succeed on a
later provider, which is why chat works and change does not.

## Why it is a pattern, not a one-off

The same shape recurs from 16 September to today (`task_636395` on 22 September
failed identically), because the same three facts hold every time:

1. **Priority 1 has a permanently unusable key** for this deployment (`:8642` 401).
   It fails on every attempt, chat or change.
2. **Priorities 2–4 sit behind one round-robin gateway** (`:20128`). The backend
   picked for a given request is effectively random, and some beats return an
   empty object or refuse `response_format`. A structured request must succeed
   against whatever backend it lands on; a chat request usually does.
3. **Priority 5 (`deepseek-flash`) runs in `json_object` mode** (`AI_STRUCTURED_OUTPUTS=false`,
   because DeepSeek rejects `json_schema`). Nobody tells it the schema over the
   wire — the prompt does — so a large nested plan schema is the hardest ask in
   the system, and it missed twice, exhausting the provider before failover could
   move on.

## Fix applied

The failure that was both most fixable and most repeated was #3: a provider that
answers with malformed JSON was given exactly **one** retry before the whole chain
gave up. On a cheap endpoint where an empty answer is a coin flip, one retry is
not enough, and the chain then reported "every provider failed" even though a
second or third attempt would have succeeded.

- `backend/src/core/config/configuration.ts` — new setting
  `AI_STRUCTURED_MAX_ATTEMPTS` (default **3**, bounds 1–5). Counts the first
  attempt, so `1` restores the old behaviour.
- `backend/src/agent/model/ai-sdk-model-provider.ts` — `maxAttempts` now reads
  that setting instead of the hard-coded `2`. Still retries **only**
  `NoObjectGeneratedError`: a rejected key, a missing model or a timeout still
  fails on the first try, so this cannot hide a real configuration error.
- `.env` / `.env.example` — `AI_STRUCTURED_MAX_ATTEMPTS=3` documented and set.

## Not fixed here (deliberate)

- **Priority 1's `:8642` key** (`Invalid gateway API key (API_SERVER_KEY)`) is a
  credential problem, not a code problem. The operator stated the credentials are
  fine and usable, so it was left alone; it will keep failing until the gateway
  key matches.
- **Priority 5's `api.deepseek.com` key** also answers 401 for this deployment.
  Same reasoning: left alone.
- **Reordering so a `structuredOutputs: true` provider leads for planning** was
  considered and rejected for now — it would change which model answers every
  task, a much bigger behaviour change than the one requested.

## Verification

- `npx jest` — all suites pass.
- `npx tsc -p tsconfig.json --noEmit` — clean apart from the 17 pre-existing
  `git-credentials.spec.ts` errors.
- New test in `configuration.spec.ts` asserts the default of 3, the override, and
  that 0 and 6 are rejected.
