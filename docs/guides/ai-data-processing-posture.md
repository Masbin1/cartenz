# AI data-processing posture

One page, per deployment, answering the register's question: *"How data being
exposed to outside LLM (to consider Data breach issue)."*

The structural answer is ADR-020 (the boundary) and ADR-055 (the per-project
flag). This page states the posture in words so a client or an auditor can read
it without reading code.

## What leaves the server, and when

A model call carries **assembled prompt material**: repository source files the
task selected, module structure, error messages, sanitised logs, Odoo metadata,
document text a person attached to the task, and the request itself. It does
not carry database dumps, customer records, credentials, or anything the filters
below catch - those are refused or redacted before the call.

**Where it goes** depends on the deployment's configured provider chain
(portal → Settings → Model providers), resolved per task:

| Provider kind | Egress |
| --- | --- |
| A loopback endpoint (the local gateway, a local agent) | none - nothing leaves the host |
| A hosted provider (Anthropic, OpenAI, OpenRouter, Groq, …) | prompt material is sent to that provider under that provider's own terms |

## What is enforced in code, in both directions

Every provider is constructed inside one guarded wrapper; there is no path to a
model that skips it (ADR-020). Three filters run in order:

1. **Sensitive-data filter** - refuses pg_dump output, INSERT batches, customer
   CSV and JSON record arrays outright.
2. **Secret scanner** - redacts nine credential formats, PEM blocks, URL
   passwords; refuses a material set that looks like a credential file.
3. **PII filter** - redacts email addresses, telephone numbers, Luhn-valid card
   numbers and plausible identity numbers.

The same filters run on tool results coming back (a repository file the platform
has never read), and every call is accounted in `agent_model_calls` (provider,
tokens, redactions). `GET /health/posture` reports that the boundary applies to
every call.

## The two deliberate exceptions

1. **Source code itself is sent** to the provider by design. The boundary
   removes customer *data*, not the customer's *code*.
2. **Image bytes bypass the text boundary** (ADR-042): a pasted screenshot is
   treated as the person's own input.

## For a client who will not accept off-host egress

Turn on **Settings → project → Data boundary → "On-host models only"**
(`projects.local_provider_only`, ADR-055). From the next task onward:

- only providers whose base URL is loopback are used for that project's tasks;
- if the deployment has no such provider, the task is **refused with a reason**
  rather than quietly using an external one;
- image attachments to that project's tasks are never sent off-host either,
  because no off-host call happens at all.

A deployment that must never egress for anyone simply configures only loopback
providers - the chain is deployment-wide until a project narrows it.

## What this posture does not cover (stated, not implied)

- The provider's own retention/logging terms - review the provider contract.
- Backups (ADR-054) contain the client's database and filestore; they stay on
  the host under `/opt/odoo/backups` and travel only where an operator moves
  them.
- `odoo_online` projects: their `odoo_api` connection talks to Odoo's own
  servers for read/write tools; that is the instance's host, not a model
  provider, and is unaffected by this flag.

## Verifying the posture today

    GET /api/v1/health/posture        # boundary applies; push/validation posture
    psql -c "select provider_id, model, redaction_count, called_external_service \
             from agent_model_calls order by created_at desc limit 20"
