# ADR-023 — Portal-managed model provider

**Status:** Accepted
**Date:** 2026-08-28
**Amends:** ADR-03 (provider abstraction), ADR-020 (AI data boundary)

## Context

The model provider was bound once at boot from `AI_PROVIDER`, `AI_API_KEY`,
`AI_BASE_URL` and `AI_MODEL`. Choosing which AI answers, or supplying a key, meant editing a file
on the server and restarting it.

That is workable for one deployment run by the person who wrote it. It is not workable for a
consultancy: the people who decide which model to use, and who hold the account it is billed to,
are not the people with shell access. Worse, the failure mode of a wrong key was a task that
cloned a repository, produced a plan, asked someone to approve it, and only then failed.

## Decision

### 1. The provider is configured per organisation, in the portal

`organization_model_settings` holds one row per organisation: provider, model, base URL, and a
reference into `secret_records`. The environment remains the fallback, so an existing
single-tenant deployment behaves exactly as it did.

The organisation is the right scope because it is the tenancy boundary everywhere else in the
platform, and because a model key is a billing relationship — which belongs to the organisation,
not to a project or a user.

### 2. The key is write-only across the HTTP boundary

There is no endpoint that returns it. The response shape the portal receives — `PublicModelSettings`
— has no field that could carry one; `hasApiKey` is the only thing said about it.

This is stated as a property of the *shape* rather than as a rule about the handler, because a rule
about a handler is one refactor away from being untrue. The plaintext exists in two places: inside
`ModelSettingsService.write`, long enough to seal it, and inside `ModelProviderResolver.build`, long
enough to hand it to the SDK. It is on no object, in no log, and in no audit payload.

### 3. Provider construction moves to a resolver, and the boundary guarantee is unchanged

`ModelProviderResolver.forOrganization` builds a provider from the organisation's settings and
caches it against the row's `revision`, so a changed key applies to the next task rather than the
next restart.

ADR-020's structural guarantee is preserved exactly: `AiSdkModelProvider` and
`ScriptedModelProvider` are constructed inside the resolver and immediately wrapped in
`GuardedModelProvider`, and neither is exported from `ModelModule`. There is no path to a provider
that skips the AI data boundary — before this change because only the guarded instance was bound,
after it because only the guarded instance is ever returned.

`ModelSettingsService` lives in its own global module rather than in `OrganizationsModule`. The
resolver needs the service, and the organisations controller needs the resolver; separating them
keeps the module graph acyclic without `forwardRef`.

### 4. A base URL must be https, except on localhost

The prompt carries repository source code and the key travels with it. A plaintext endpoint sends
both in the clear.

`http://localhost` is permitted because a self-hosted model on the same host has no network to
intercept, and refusing it would push people towards worse workarounds.

### 5. A configuration that cannot work is refused at save time

A provider that calls out with no key is refused, and so is `openai-compatible` with no base URL.
The alternative is a valid-looking row that fails on the next task, by which time the person who
saved it has gone and someone else is reading a stack trace.

### 6. There is a connection test

`POST /organizations/{id}/model-provider/test` makes one structured call with a trivial prompt and
reports what happened. It carries no repository content, so it can be run before any project is
connected — which is the point.

A failure is returned rather than thrown: "your key was rejected" is an answer to the question
asked, and the provider's own message is kept so that a wrong URL and a wrong key read differently.

The check is *structured* rather than free text on purpose. A provider that can complete but cannot
produce structured output would pass a plain-text check and fail every real task.

## Consequences

Switching model, rotating a key, or moving from Anthropic to a self-hosted endpoint is a screen and
a Save. The key never reaches a file, a log, a browser or this repository.

Costs: a table, a migration, and provider construction on a cache miss rather than once at boot.
The resolver's cache is per process, so the API and the worker each build their own — acceptable,
because building one is a database read and an unseal.

One thing this deliberately does not do: it does not let an organisation configure a provider the
platform does not support. `MODEL_PROVIDER_IDS` is a closed set, and `openai-compatible` is one
entry rather than a list of vendors, because that is what it is — any endpoint speaking that wire
format. Naming each vendor would imply knowledge the platform does not have.

### A finding worth recording

The first audit row for this feature read
`{"credentialStored":"[redacted]","credentialReplaced":"[redacted]"}`. The audit redaction filter
matches on field *names*, and both contained a denied fragment, so it blanked two booleans that
carry no secret. The filter was right to; the fix was to use the `ALLOWED_KEYS` mechanism that
exists for exactly this, and to add a test. Without it the event recorded that something happened
and nothing about what.

While there, a duplicate `ALLOWED_KEYS` entry was removed: both sides pass through `normaliseKey`,
so `hasCredentials` and `hascredentials` were the same entry twice.

## Verification

| What | How | Result |
| --- | --- | --- |
| Refuses a provider with no key, no base URL, a bad URL, plaintext http, over-long values | `model-settings.spec.ts` | 6 tests |
| The audit trail keeps the facts and removes the key | `redact.spec.ts` | 2 new tests, 12 in the suite |
| The key is not in the response, the audit trail, or the stored row | Manual run against the live stack | Confirmed in all three |
| A wrong key is reported, not thrown | `POST .../test` with a fake Anthropic key | `ok: false`, provider's own message |
| Clearing reverts to the environment | Manual run | Row deleted, `fromEnvironment: true` |
| Another organisation can neither read nor write it | Manual run | 404 on both |
| The screen shipped and never renders a token | `verify-portal-settings.sh` | 13 checks |
| No regressions | 294 unit tests; four smoke suites | All pass |

**Not verified:** a successful call to a real provider. No valid key has been supplied, and asking
for one in chat is not how a key should travel. The rejection path was exercised against
Anthropic's live API, so the request is well-formed enough to be rejected on authentication rather
than on shape — but "a real model produced a plan" remains untested.

## Amendment, 2026-08-31 — configuring a DeepSeek key, and a local gateway

A DeepSeek key was configured and the connection test failed. The cause was three
defects of mine, each of which made the next harder to see.

**The model name was guessed.** `defaultModelFor` returned `gpt-4o-mini` for any
`openai-compatible` provider. But that setting names a *wire format*, not a vendor: the endpoint
may be OpenAI, DeepSeek, Groq, OpenRouter or something self-hosted, and they share no model names.
So a DeepSeek endpoint was asked for a model it has never heard of, and answered "Model Not Exist" —
which reads exactly like a rejected key.

There is nothing sensible to default to, so it no longer defaults. A model name is now required for
`openai-compatible`, refused at save time and at construction, with real examples in the message.
Anthropic keeps its default, because it names a company whose current model can be named.

**The error said nothing.** Provider messages were suppressed on the grounds that they can echo the
prompt, which is customer source code. True, and it meant a wrong key, a wrong model, an expired
card and an unsupported feature were reported identically as "the provider rejected the request".

The distinction missed is that a provider's *error message* is a fact about the configuration, not
about the request. `{"error":{"message":"Model Not Exist"}}` contains nothing of the prompt. The
HTTP status is now mapped — 401 key rejected, 403 not permitted for that model, 402 no credit,
404 no such model or wrong URL, 400 malformed or structured output unsupported — and the provider's
own message is quoted, bounded to 200 characters and reduced to a single line. The prompt is still
never quoted.

**Test did not save.** It tested what was stored rather than what was on screen, so typing a key and
pressing Test exercised the previous configuration — or, with nothing stored, fell through to the
mock provider and reported success saying no model was called. The button now saves first and says
"Save and test".

### A local gateway may have no key

Reaching a third party requires a credential. A gateway on the same machine does not: ollama and
llama.cpp have none to give. The requirement was written against the provider's *name* and so
refused a legitimate on-premise configuration.

It now depends on where the endpoint is. `isLoopbackUrl` is defined once and shared by the two rules
that ask the same question — plain http is accepted only for loopback, and a key is required only
when the endpoint is not — because two definitions would eventually disagree, and the direction they
would disagree in is waiving a credential requirement for a third party.

Three layers had to agree: the save validation, the resolver, and the provider. The first two were
found by testing the behaviour rather than the units; the resolver refused a keyless configuration
that the save had just accepted.

### Verified against a real local gateway

The Hermes gateway on this host serves the OpenAI wire format at `http://127.0.0.1:20128/v1` and
does authenticate.

| What | Result |
| --- | --- |
| `http://127.0.0.1:20128/v1` accepted despite plain http | PASS |
| The platform reaches it and reports its answer | PASS — "The provider said: Invalid API key" |
| A keyless loopback gateway can be configured | PASS |
| A third-party endpoint with no key is still refused | PASS |
| An `openai-compatible` endpoint with no model name is refused, naming examples | PASS |
| `localhost.example.com` is not treated as local | PASS |
