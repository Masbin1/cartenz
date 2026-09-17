# ADR-055: A per-project "on-host models only" flag

- Status: Accepted
- Date: 18 September 2026
- Milestone: Phase 5 (data governance)

Builds on ADR-020 (the AI data boundary) and ADR-044 (one deployment,
region-scoped).

## Context

Register item 6 asked how data is exposed to an outside LLM. The structural
answer exists (ADR-020): one guarded chokepoint, three filters in both
directions, per-call accounting. Two gaps were recorded as deliberate:

1. **Source code is sent to the provider by design** - the boundary removes
   customer *data*, not the customer's *code*.
2. **Image bytes bypass the text boundary** - a pasted screenshot is treated as
   the operator's own input.

The register's next step was: document a one-page data-processing posture, and
add an explicit per-project "local provider only" flag for clients who will not
accept off-host egress. A deployment can already be configured to use only local
providers (the loopback gateway, or a local agent) - but that is a
*deployment-wide* choice, and one client on the estate should not force it on
every other.

## Decision

### 1. The flag is per project, and it refuses rather than degrades

`projects.local_provider_only` (default false) narrows the model chain **for one
project's tasks** to providers whose base URL is loopback (`isLoopbackUrl` - the
same predicate the settings validation already uses). When the narrowed chain is
empty, the task is refused with a message naming the cause; a model call is
never silently made to an external provider under a project that forbids one.

The distinction matters: filtering the chain and calling whatever remains is
helpful; filtering the chain and forgetting what was removed is a data breach
with a log line.

### 2. The flag rides on the task snapshot

`TaskExecutionSnapshot.localProviderOnly` is read with the rest of the task's
facts and passed into the planner, the implementation loop and the chat loop,
which pass it to `ModelProviderResolver.forProject(projectId, { localOnly })`.
The resolver's cache key includes it, so a cached provider built without the
restriction is never handed to a task that requires it.

### 3. Only an admin may change it

Same rank as the agent permissions it sits beside (`requireAdmin`): turning the
flag **off** is what re-allows off-host egress, so it is not any member's
decision. The portal shows it on the project's settings page as a
"Data boundary" switch that saves immediately - one boolean, and a half-saved
permissions form must not carry it along.

### 4. The posture is written down, per deployment

`docs/guides/ai-data-processing-posture.md` is the one-page statement the
register asked for: which provider this deployment uses, what is sent, what is
filtered, what the two deliberate exceptions are, and how to go fully on-host.

## What this does not do

- It does not filter *what* is sent to an eligible local provider - the boundary
  already does that, and a local provider is still a model call.
- It does not change the deployment-wide chain; it narrows it per project.
- It does not make image bytes pass the text boundary; that remains ADR-042's
  recorded exception, unchanged by this flag (a local-only project never sends
  one off-host, which is the practical mitigation).

## Retirement

If the boundary gains a binary-aware path for attachments, the flag's practical
scope narrows to source code and it should be re-read rather than assumed.
