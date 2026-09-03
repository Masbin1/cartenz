# Multi-provider model configuration with failover — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single stored model provider with an ordered list configured in the portal, tried in priority order so a rate-limited or dead endpoint falls through to the next.

**Architecture:** `organization_model_settings` becomes one row per provider (`priority`, `label`, `enabled`, `structured_outputs`). `ModelProviderResolver` builds the enabled rows in priority order and returns a `FailoverModelProvider` wrapped, as today, in `GuardedModelProvider` — so callers still receive one `ModelProvider` and the AI data boundary is still crossed exactly once, outside the chain. The environment stays the last resort when an organisation has no rows.

**Tech Stack:** NestJS, Drizzle ORM (PostgreSQL), Vercel AI SDK, Jest (ts-jest), Next.js 14 App Router, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-04-multi-provider-failover-design.md`

## Global Constraints

- **The boundary is never bypassed.** `GuardedModelProvider` stays the outermost wrapper. `AiSdkModelProvider`, `ScriptedModelProvider` and `FailoverModelProvider` are constructed inside `ModelProviderResolver` and never exported from `ModelModule`.
- **`AiBoundaryRefusalError` is rethrown untouched by failover.** A refusal is a human decision; retrying it against another endpoint would turn a security refusal into a retry loop.
- **The API key is write-only across the HTTP boundary.** No endpoint returns it, no audit payload carries it, no response shape has a field it could occupy. Audit metadata uses names without "key" in them (`credentialReplaced`, `credentialStored`) — the redaction filter matches on field names and blanks anything key-shaped.
- **Base URLs must be https, except loopback.** Enforced in `ModelSettingsService`, one authority only.
- **Migrations are never applied on boot.** Generated into `backend/drizzle`, applied by `npm run db:migrate`.
- **British spelling in comments and user-facing copy** ("organisation"), matching the existing codebase.
- **Comments explain why, not what.** Match the density and voice of the surrounding files.
- Baseline before any change: **493 tests, 44 suites, all passing** (`cd backend && npx jest`). Every task ends with this suite green.

---

## File Structure

**Backend — created:**

| File | Responsibility |
| --- | --- |
| `backend/src/agent/model/failover-model-provider.ts` | Tries an ordered list of providers; decides move-on vs stop from the error |
| `backend/src/agent/model/failover-model-provider.spec.ts` | Move-on / stop matrix, boundary passthrough, first-priority error reporting |
| `backend/drizzle/0005_model_provider_list.sql` | Additive migration to one row per provider |

**Backend — modified:**

| File | Change |
| --- | --- |
| `backend/src/agent/model/ai-sdk-model-provider.ts` | Distinguish a rejected placeholder from a rejected key |
| `backend/src/modules/organizations/model-settings.service.ts` | Warn on a keyless loopback row; then list operations replacing single-row ones |
| `backend/src/core/database/schema.ts` | New columns on `organizationModelSettings` |
| `backend/src/core/enums.ts` | `MODEL_PROVIDER_PRESETS` |
| `backend/src/agent/model/model-provider-resolver.ts` | Build a list; test one row or the chain; discover models |
| `backend/src/modules/organizations/organizations.controller.ts` | List endpoints replacing the single-provider ones |
| `backend/src/modules/organizations/dto/model-settings.dto.ts` | DTOs for write, reorder, discover |
| `backend/src/core/audit/audit-events.ts` | `MODEL_PROVIDER_REORDERED` |
| `backend/src/agent/orchestration/agent-workflow.ts:1143` | Record the provider actually used, not the environment's |

**Frontend — modified:**

| File | Change |
| --- | --- |
| `frontend/lib/types.ts` | `ModelProviderRow`, `ModelProviderList`, extended `ModelProviderTestResult` |
| `frontend/lib/api.ts` | List, reorder, per-row test, chain test, discover |
| `frontend/app/settings/page.tsx` | Ordered list UI with presets and model discovery |

**Task order.** Task 1 ships alone and first: it fixes a defect that breaks this installation today, independent of everything after it. Tasks 2-4 are backend and each leave the suite green. Tasks 5-6 are the UI, which needs Task 4's endpoints.

---

### Task 1: The keyless loopback row reports honestly

The defect verified on this host: three of four stored rows have `secret_ref = NULL`, and the resulting failure reads `openai-compatible rejected the API key` when no key was ever stored. Ships as its own commit, before the list work.

**Files:**
- Modify: `backend/src/agent/model/ai-sdk-model-provider.ts:90-115`
- Modify: `backend/src/modules/organizations/model-settings.service.ts:38-46,146-249`
- Test: `backend/src/agent/model/provider-errors.spec.ts`
- Test: `backend/src/modules/organizations/model-settings.spec.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `PublicModelSettings.warning: string | null` — Task 5 renders it. `AiSdkModelProvider` gains a private `usingPlaceholderKey: boolean` used only by `explain()`.

- [ ] **Step 1: Write the failing test for the placeholder message**

Append to `backend/src/agent/model/provider-errors.spec.ts`:

```typescript
describe('a local gateway that authenticates, configured with no key', () => {
  const config = { ai: { model: '', baseUrl: '', apiKey: '' } } as unknown as AppConfig;

  /**
   * 9router and Hermes authenticate; ollama and llama.cpp do not. The platform
   * substitutes a placeholder for a loopback endpoint with no key, so a gateway
   * that does authenticate answers 401 — and the message used to say the key was
   * rejected, which is how an afternoon disappears looking for a key that was
   * never stored.
   */
  it('says no key is stored, rather than that the key was rejected', () => {
    const provider = new AiSdkModelProvider(config, {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:20128/v1',
      model: 'Paket-Hemat',
      apiKey: '',
    });

    const explain = (provider as unknown as {
      explain(status: number | undefined, retryable: boolean, error: unknown): string;
    }).explain.bind(provider);

    const message = explain(401, false, {});

    expect(message).toContain('no key is stored');
    expect(message).not.toContain('rejected the API key');
  });

  it('still reports a genuine rejection when a key was supplied', () => {
    const provider = new AiSdkModelProvider(config, {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:20128/v1',
      model: 'Paket-Hemat',
      apiKey: 'sk-real-key',
    });

    const explain = (provider as unknown as {
      explain(status: number | undefined, retryable: boolean, error: unknown): string;
    }).explain.bind(provider);

    expect(explain(401, false, {})).toContain('rejected the API key');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && npx jest src/agent/model/provider-errors.spec.ts -t 'no key is stored'`
Expected: FAIL — the message reads `openai-compatible rejected the API key.`

- [ ] **Step 3: Record that a placeholder was substituted**

In `backend/src/agent/model/ai-sdk-model-provider.ts`, add the field beside the other private members (near `private readonly language: LanguageModel;`):

```typescript
  /**
   * True when no key was configured and a loopback placeholder was sent instead.
   *
   * Kept so a 401 can distinguish "your key was refused" from "there was no key
   * to send". They read identically otherwise, and the second is the common case
   * on a host running 9router or Hermes, which authenticate — unlike ollama and
   * llama.cpp, for which a keyless row is correct.
   */
  private usingPlaceholderKey = false;
```

In `resolveModel`, set it where the placeholder is chosen:

```typescript
    const local = isLoopbackUrl(settings.baseUrl);
    const apiKey = settings.apiKey || (local ? 'not-required-for-a-local-gateway' : '');
    this.usingPlaceholderKey = !settings.apiKey && local;
```

- [ ] **Step 4: Branch the 401 message on it**

In `explain`, replace the `case 401:` arm:

```typescript
      case 401:
        return this.usingPlaceholderKey
          ? `${this.id} refused the request because no key is stored. A placeholder is ` +
            'sent for a local endpoint, and this gateway authenticates. Enter a token ' +
            `in the organisation settings.${suffix}`
          : `${this.id} rejected the API key.${suffix}`;
```

- [ ] **Step 5: Run both tests**

Run: `cd backend && npx jest src/agent/model/provider-errors.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the failing test for the save-time warning**

Append inside the existing top-level `describe('ModelSettingsService', ...)` in `backend/src/modules/organizations/model-settings.spec.ts`:

```typescript
  describe('a loopback row saved with no key', () => {
    /**
     * Accepted, not refused: ollama and llama.cpp genuinely have no key to give.
     * But 9router and Hermes authenticate, and the failure they produce arrives a
     * task later, far from the person who saved the row.
     */
    it('warns rather than refusing, because ollama has no key to give', () => {
      const service = build();
      const warn = (service as unknown as {
        keylessLoopbackWarning(baseUrl: string | null, hasKey: boolean): string | null;
      }).keylessLoopbackWarning.bind(service);

      const warning = warn('http://127.0.0.1:20128/v1', false);

      expect(warning).toContain('9router');
      expect(warning).toContain('ollama');
    });

    it('says nothing when a key is stored', () => {
      const service = build();
      const warn = (service as unknown as {
        keylessLoopbackWarning(baseUrl: string | null, hasKey: boolean): string | null;
      }).keylessLoopbackWarning.bind(service);

      expect(warn('http://127.0.0.1:20128/v1', true)).toBeNull();
    });

    it('says nothing for an endpoint that is not on this machine', () => {
      const service = build();
      const warn = (service as unknown as {
        keylessLoopbackWarning(baseUrl: string | null, hasKey: boolean): string | null;
      }).keylessLoopbackWarning.bind(service);

      // A third-party endpoint with no key is refused outright elsewhere, so a
      // warning here would be a second, weaker answer to a settled question.
      expect(warn('https://api.deepseek.com', false)).toBeNull();
    });
  });
```

- [ ] **Step 7: Run it and watch it fail**

Run: `cd backend && npx jest src/modules/organizations/model-settings.spec.ts -t 'loopback row'`
Expected: FAIL — `keylessLoopbackWarning is not a function`.

- [ ] **Step 8: Add the warning**

In `backend/src/modules/organizations/model-settings.service.ts`, add to the `PublicModelSettings` interface:

```typescript
  /**
   * Set when the stored configuration is accepted but likely to fail: a loopback
   * endpoint with no key. Null when there is nothing to say.
   */
  readonly warning: string | null;
```

Add the private method beside `assertValid`:

```typescript
  /**
   * What to tell someone who saved a local endpoint without a key.
   *
   * Not a refusal: ollama and llama.cpp have no key to give, and refusing would
   * break a legitimate deployment. But 9router and Hermes authenticate, and
   * without this the failure arrives on the next task as "rejected the API key",
   * which sends people looking for a key that was never stored.
   */
  private keylessLoopbackWarning(baseUrl: string | null, hasKey: boolean): string | null {
    if (hasKey || !isLoopbackUrl(baseUrl)) return null;

    return (
      'No API token is stored. Local gateways differ: 9router and Hermes authenticate ' +
      'and will refuse the request, while ollama and llama.cpp need no token. If this ' +
      'endpoint authenticates, enter its token.'
    );
  }
```

In `describe`, populate it — the existing return gains one field:

```typescript
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      warning: this.keylessLoopbackWarning(
        resolved.baseUrl,
        resolved.fromEnvironment ? Boolean(this.config.ai.apiKey) : resolved.secretRef !== null,
      ),
```

- [ ] **Step 9: Run the settings suite**

Run: `cd backend && npx jest src/modules/organizations/model-settings.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 10: Surface the warning in the portal**

In `frontend/lib/types.ts`, add to `ModelProviderSettings`:

```typescript
  /** Set when the configuration is accepted but likely to fail. */
  warning: string | null;
```

In `frontend/app/settings/page.tsx`, after the `{notice ? ... : null}` line:

```tsx
      {settings.warning ? <Alert tone="warning">{settings.warning}</Alert> : null}
```

Check `frontend/components/ui/alert.tsx` for the tones it accepts. If `warning` is not one, use `tone="error"` — the message is a real problem, not decoration.

- [ ] **Step 11: Full suite and typecheck**

Run: `cd backend && npx jest && npm run typecheck && cd ../frontend && npm run typecheck`
Expected: 496 tests passing, both typechecks clean.

- [ ] **Step 12: Commit**

```bash
git add backend/src/agent/model/ai-sdk-model-provider.ts \
        backend/src/agent/model/provider-errors.spec.ts \
        backend/src/modules/organizations/model-settings.service.ts \
        backend/src/modules/organizations/model-settings.spec.ts \
        frontend/lib/types.ts frontend/app/settings/page.tsx
git commit -m "$(cat <<'MSG'
Tell a keyless local gateway apart from a rejected key

Three of the four stored rows on this host have no secret_ref. A loopback
endpoint with no key gets a placeholder, and 9router — which authenticates,
unlike ollama — answers 401, which the platform reported as "rejected the API
key". The key had never been stored, so the message sent people looking for
something that was not there. The save now warns, and the 401 says which of the
two happened.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: The schema holds a list

**Files:**
- Modify: `backend/src/core/database/schema.ts:238-259`
- Create: `backend/drizzle/0005_model_provider_list.sql`
- Modify: `backend/drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `organizationModelSettings` with `id: uuid` (PK), `priority: integer`, `label: text`, `enabled: boolean`, `structuredOutputs: boolean | null`. Tasks 3-4 query it.

- [ ] **Step 1: Change the table definition**

In `backend/src/core/database/schema.ts`, replace the `organizationModelSettings` table (lines 238-259) with:

```typescript
export const organizationModelSettings = pgTable(
  'organization_model_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * Tried in ascending order. Unique per organisation, so "which is first" has
     * one answer rather than a tie the database would break arbitrarily.
     */
    priority: integer('priority').notNull().default(1),
    /** What a person calls this entry: "9router Paket-Hemat", "DeepSeek fallback". */
    label: text('label'),
    /** False takes it out of the chain without discarding its stored key. */
    enabled: boolean('enabled').notNull().default(true),
    providerId: text('provider_id', { enum: asEnum(MODEL_PROVIDER_IDS) }).notNull(),
    /** Null means "the provider's default", resolved when the provider is built. */
    model: text('model'),
    /** Required for openai-compatible, meaningless for the others. */
    baseUrl: text('base_url'),
    /**
     * Whether this endpoint enforces a JSON schema itself.
     *
     * Per row rather than per deployment because a fallback chain needs both
     * answers at once: DeepSeek rejects response_format json_schema, the local
     * gateway accepts it, and a chain crossing the two cannot work off a single
     * environment value. Null follows AI_STRUCTURED_OUTPUTS.
     */
    structuredOutputs: boolean('structured_outputs'),
    /** Reference into secret_records. Null for mock, which calls nothing. */
    secretRef: text('secret_ref'),
    /**
     * Bumped on every write. The resolver caches built providers against the sum
     * of an organisation's revisions, so any edit, addition or removal changes it
     * and the chain is rebuilt on the next task rather than on the next restart.
     */
    revision: integer('revision').notNull().default(1),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byOrganizationPriority: uniqueIndex('organization_model_settings_priority_idx').on(
      table.organizationId,
      table.priority,
    ),
  }),
);
```

Check the import line at the top of the file: `uniqueIndex` and `boolean` must both be imported from `drizzle-orm/pg-core`. Add whichever is missing.

- [ ] **Step 2: Write the migration by hand**

`drizzle-kit generate` would emit a destructive primary-key swap that drops the existing rows. Write `backend/drizzle/0005_model_provider_list.sql`:

```sql
-- One row per provider (ADR-023 extended). Additive: existing rows become
-- priority 1 with a label derived from their provider, and keep their keys.
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "structured_outputs" boolean;
--> statement-breakpoint
UPDATE "organization_model_settings" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
--> statement-breakpoint
UPDATE "organization_model_settings"
   SET "label" = CASE
     WHEN "provider_id" = 'mock' THEN 'No model (scripted)'
     WHEN "provider_id" = 'anthropic' THEN 'Anthropic'
     ELSE COALESCE("model", 'OpenAI-compatible endpoint')
   END
 WHERE "label" IS NULL;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" DROP CONSTRAINT IF EXISTS "organization_model_settings_pkey";
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD PRIMARY KEY ("id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_model_settings_priority_idx" ON "organization_model_settings" ("organization_id","priority");
```

- [ ] **Step 3: Register it in the journal**

Append to the `entries` array in `backend/drizzle/meta/_journal.json`, after the `0004` entry:

```json
    {
      "idx": 5,
      "version": "7",
      "when": 1788500000000,
      "tag": "0005_model_provider_list",
      "breakpoints": true
    }
```

- [ ] **Step 4: Apply it and check the existing rows survived**

```bash
cd backend && npm run db:migrate
DB=$(grep '^DATABASE_URL=' ../.env | cut -d= -f2-)
psql "$DB" -c 'select id is not null as has_id, priority, label, enabled, provider_id, secret_ref is not null as has_key from organization_model_settings order by priority;'
```

Expected: 4 rows, each with `has_id = t`, `priority = 1`, a non-null `label`, `enabled = t`. The row with `has_key = t` still has it.

- [ ] **Step 5: Typecheck and full suite**

Run: `cd backend && npm run typecheck && npx jest`
Expected: typecheck clean, 496 tests passing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/core/database/schema.ts backend/drizzle/0005_model_provider_list.sql backend/drizzle/meta/_journal.json
git commit -m "$(cat <<'MSG'
Give an organisation a list of providers rather than one

The table's primary key was the organisation, so there was nowhere to put a
second provider. It is now one row per provider, ordered by priority, with a
per-row structured_outputs — a chain crossing DeepSeek and the local gateway
needs both answers at once, and AI_STRUCTURED_OUTPUTS only has one.

The migration is written by hand rather than generated: drizzle-kit's
primary-key swap drops the table, and the four rows on this host carry a sealed
key each.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Failover

**Files:**
- Create: `backend/src/agent/model/failover-model-provider.ts`
- Create: `backend/src/agent/model/failover-model-provider.spec.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `ModelProviderError` from `./model-provider.interface`; `AiBoundaryRefusalError` from `../../core/ai-boundary/boundary-types`.
- Produces: `class FailoverModelProvider implements ModelProvider`, constructed as `new FailoverModelProvider(members: readonly FailoverMember[])` where `FailoverMember = { readonly priority: number; readonly label: string; readonly provider: ModelProvider }`. Task 4 constructs it.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/agent/model/failover-model-provider.spec.ts`:

```typescript
import { z } from 'zod';
import { FailoverModelProvider } from './failover-model-provider';
import { ModelProviderError, type ModelProvider } from './model-provider.interface';
import { AiBoundaryRefusalError } from '../../core/ai-boundary/boundary-types';

/**
 * The chain that keeps a task alive when one endpoint will not serve it
 * (ADR-023 extended).
 *
 * The distinction under test is which failures mean "this provider cannot do it"
 * and which mean "nobody can". Moving on from the second wastes a task's budget
 * to arrive at the same answer, and moving on from a boundary refusal would turn
 * a security decision into a retry loop.
 */
describe('FailoverModelProvider', () => {
  const schema = z.object({ status: z.string() });

  const request = {
    system: 'system',
    parts: [{ label: 'Check', content: 'go' }],
    schema,
    schemaName: 'Check',
  };

  /** A provider that answers, or fails with exactly what it is given. */
  const stub = (id: string, failure?: unknown): ModelProvider => ({
    id,
    model: `${id}-model`,
    callsExternalService: true,
    generateStructured: async () => {
      if (failure) throw failure;
      return {
        value: { status: 'OK' } as never,
        usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
        boundaryFindings: [],
        redactionCount: 0,
        steps: 1,
      };
    },
    runToolLoop: async () => {
      if (failure) throw failure;
      return {
        value: { summary: 'done', toolCalls: 0 },
        usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
        boundaryFindings: [],
        redactionCount: 0,
        steps: 1,
      };
    },
  });

  const chain = (...members: { provider: ModelProvider; label?: string }[]) =>
    new FailoverModelProvider(
      members.map((entry, index) => ({
        priority: index + 1,
        label: entry.label ?? `member-${index + 1}`,
        provider: entry.provider,
      })),
    );

  const httpError = (status: number) =>
    Object.assign(new ModelProviderError('openai-compatible', `HTTP ${status}`, status >= 500), {
      statusCode: status,
    });

  describe('moving on', () => {
    // 429 is the case the feature exists for: one account's quota is spent and
    // another account's is not.
    it.each([401, 402, 403, 404, 429, 500, 503])(
      'tries the next provider after HTTP %i',
      async (status) => {
        const second = stub('second');
        const provider = chain({ provider: stub('first', httpError(status)) }, { provider: second });

        const result = await provider.generateStructured(request);

        expect(result.value).toEqual({ status: 'OK' });
      },
    );

    it('skips straight past a provider that timed out', async () => {
      const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      const provider = chain({ provider: stub('first', timeout) }, { provider: stub('second') });

      await expect(provider.generateStructured(request)).resolves.toMatchObject({
        value: { status: 'OK' },
      });
    });

    it('fails over in the tool loop too, not only in structured generation', async () => {
      const provider = chain(
        { provider: stub('first', httpError(429)) },
        { provider: stub('second') },
      );

      const result = await provider.runToolLoop({
        system: 'system',
        parts: [],
        tools: [],
        execute: async () => ({ result: {} }),
        maxSteps: 1,
        maxToolCalls: 1,
      });

      expect(result.value.summary).toBe('done');
    });
  });

  describe('stopping', () => {
    // A malformed request is malformed everywhere. Trying it against three
    // endpoints spends three times as much to be told the same thing.
    it('stops on HTTP 400 rather than asking everyone else', async () => {
      const second = stub('second');
      const spy = jest.spyOn(second, 'generateStructured');
      const provider = chain({ provider: stub('first', httpError(400)) }, { provider: second });

      await expect(provider.generateStructured(request)).rejects.toThrow(ModelProviderError);
      expect(spy).not.toHaveBeenCalled();
    });

    /**
     * The rule that matters most. A refusal means the material must not be sent
     * to a provider — any provider. Failing over would ask a second endpoint for
     * exactly what the first was forbidden.
     */
    it('rethrows a boundary refusal untouched and calls nobody else', async () => {
      const refusal = new AiBoundaryRefusalError('a credential was found', []);
      const second = stub('second');
      const spy = jest.spyOn(second, 'generateStructured');
      const provider = chain({ provider: stub('first', refusal) }, { provider: second });

      await expect(provider.generateStructured(request)).rejects.toBe(refusal);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('when every provider fails', () => {
    /**
     * The first priority's error, not the last. The last is usually the least
     * informative, and the question being asked is why the primary failed.
     */
    it('reports the first priority failure and summarises the rest', async () => {
      const provider = chain(
        { provider: stub('first', httpError(401)), label: 'nine-router' },
        { provider: stub('second', httpError(429)), label: 'deepseek' },
      );

      let message = '';
      try {
        await provider.generateStructured(request);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('HTTP 401');
      expect(message).toContain('nine-router');
      expect(message).toContain('deepseek');
    });
  });

  describe('the list itself', () => {
    it('reports the first member as its identity, which is what it usually is', () => {
      const provider = chain({ provider: stub('first') }, { provider: stub('second') });

      expect(provider.id).toBe('first');
      expect(provider.model).toBe('first-model');
    });

    it('refuses to be built empty, because there is nothing to call', () => {
      expect(() => new FailoverModelProvider([])).toThrow(/at least one/);
    });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd backend && npx jest src/agent/model/failover-model-provider.spec.ts`
Expected: FAIL — module not found.

Check the `AiBoundaryRefusalError` constructor signature at `backend/src/core/ai-boundary/boundary-types.ts:70` and adjust the test's construction if it takes different arguments.

- [ ] **Step 3: Implement it**

Create `backend/src/agent/model/failover-model-provider.ts`:

```typescript
import { Logger } from '@nestjs/common';
import { AiBoundaryRefusalError } from '../../core/ai-boundary/boundary-types';
import {
  ModelProviderError,
  type ModelProvider,
  type ModelResult,
  type StructuredRequest,
  type ToolLoopOutcome,
  type ToolLoopRequest,
} from './model-provider.interface';

/** One entry in the chain, carrying what a failure report needs to name it. */
export interface FailoverMember {
  readonly priority: number;
  readonly label: string;
  readonly provider: ModelProvider;
}

/**
 * An ordered list of providers, tried until one answers (ADR-023 extended).
 *
 * Presented as a single ModelProvider so the agent layer is unchanged: the
 * planner and the implementation loop each ask for one provider and get one.
 *
 * This class is constructed inside ModelProviderResolver and wrapped in
 * GuardedModelProvider, which stays the outermost layer. That ordering is the
 * point: the boundary is crossed once for the whole chain, so a refusal happens
 * before any provider is reached and cannot be retried against the next one.
 */
export class FailoverModelProvider implements ModelProvider {
  private readonly logger = new Logger(FailoverModelProvider.name);

  constructor(private readonly members: readonly FailoverMember[]) {
    if (members.length === 0) {
      throw new ModelProviderError(
        'failover',
        'A failover chain needs at least one provider. An organisation with no ' +
          'configured providers falls back to the environment instead.',
        false,
      );
    }
  }

  /** The first member's identity, which is the one that usually answers. */
  get id(): string {
    return this.members[0].provider.id;
  }

  get model(): string {
    return this.members[0].provider.model;
  }

  get callsExternalService(): boolean {
    return this.members.some((member) => member.provider.callsExternalService);
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<ModelResult<T>> {
    return this.attempt('structured generation', (provider) =>
      provider.generateStructured(request),
    );
  }

  async runToolLoop(request: ToolLoopRequest): Promise<ModelResult<ToolLoopOutcome>> {
    return this.attempt('tool loop', (provider) => provider.runToolLoop(request));
  }

  /**
   * One pass down the list. A member that fails is not tried again in this call.
   *
   * There is no delay between attempts: exponential backoff already exists at the
   * queue layer, and adding it here would make one task wait twice.
   *
   * ponytail: no cooldown — a provider that just failed is tried again on the
   * next call. Cooldown needs state shared between worker processes, i.e. Redis,
   * for a problem not yet demonstrated. The cost is one wasted call per model
   * call while the primary is down, not per task, since providers are cached. If
   * it becomes a real cost, add a Redis key per member with a short TTL.
   */
  private async attempt<T>(
    operation: string,
    run: (provider: ModelProvider) => Promise<ModelResult<T>>,
  ): Promise<ModelResult<T>> {
    const failures: { member: FailoverMember; error: Error }[] = [];

    for (const member of this.members) {
      try {
        const result = await run(member.provider);

        if (failures.length > 0) {
          this.logger.log(
            `${operation} succeeded on priority ${member.priority} (${member.label}) ` +
              `after ${failures.length} provider(s) failed`,
          );
        }

        return result;
      } catch (error) {
        // A refusal means the material must not go to a provider — any provider.
        // Rethrown before it can be mistaken for a provider that is merely
        // unwilling, which is the one failure that must never fail over.
        if (error instanceof AiBoundaryRefusalError) throw error;

        if (!movesOn(error)) throw error;

        failures.push({ member, error: error as Error });
        this.logger.warn(
          `Priority ${member.priority} (${member.label}) failed ${operation}: ` +
            `${(error as Error).message}. Trying the next provider.`,
        );
      }
    }

    throw this.exhausted(failures);
  }

  /**
   * The failure reported when nobody answered.
   *
   * The first priority's error, with the others summarised. The last provider's
   * error is usually the least informative, and the question a person is asking
   * is why their primary choice failed.
   */
  private exhausted(failures: { member: FailoverMember; error: Error }[]): ModelProviderError {
    const [primary] = failures;
    const others = failures
      .slice(1)
      .map((entry) => `${entry.member.label}: ${entry.error.message}`)
      .join('; ');

    const retryable =
      primary.error instanceof ModelProviderError ? primary.error.retryable : false;

    return new ModelProviderError(
      primary.member.provider.id,
      `Every configured provider failed. Priority ${primary.member.priority} ` +
        `(${primary.member.label}): ${primary.error.message}` +
        (others ? ` Then ${others}` : ''),
      retryable,
    );
  }
}

/**
 * Whether this failure means "this provider cannot", rather than "nobody can".
 *
 * A rejected key, a spent account, a missing model, a rate limit and an
 * unavailable endpoint are all facts about one provider — the next one has its
 * own key, quota and model list. A malformed request and a response that does not
 * match the schema are not: every provider would answer the same way, and asking
 * them spends a task's budget to find that out.
 */
function movesOn(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  if (typeof status === 'number') {
    if (status === 400) return false;
    if (status === 401 || status === 402 || status === 403 || status === 404) return true;
    if (status === 429 || status >= 500) return true;
  }

  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return true;

  // A schema mismatch is this row's structuredOutputs being wrong, which the
  // next provider does not fix and which the person configuring it must see.
  if (name === 'ZodError' || name === 'NoObjectGeneratedError') return false;

  const message = error instanceof Error ? error.message : String(error);
  return /rate.?limit|overloaded|unavailable|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(message);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx jest src/agent/model/failover-model-provider.spec.ts`
Expected: PASS, 14 tests.

If the `it.each` status cases fail, check that `ModelProviderError` instances carry `statusCode` — the test attaches it with `Object.assign`, and `movesOn` reads it from there.

- [ ] **Step 5: Full suite**

Run: `cd backend && npx jest && npm run typecheck`
Expected: 510 tests passing, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/model/failover-model-provider.ts backend/src/agent/model/failover-model-provider.spec.ts
git commit -m "$(cat <<'MSG'
Try each configured provider in turn when one will not serve

A rejected key, a spent account, a rate limit or a dead endpoint is a fact about
one provider; the next has its own key and quota. A malformed request and a
schema mismatch are not, and asking three endpoints spends three times as much
to hear the same answer.

A boundary refusal is rethrown untouched. Failing that over would ask a second
endpoint for exactly what the first was forbidden to send, which is why the
guard stays outside this class rather than inside each member.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: The service, resolver and endpoints speak lists

**Files:**
- Modify: `backend/src/modules/organizations/model-settings.service.ts`
- Modify: `backend/src/modules/organizations/model-settings.spec.ts`
- Modify: `backend/src/agent/model/model-provider-resolver.ts`
- Modify: `backend/src/modules/organizations/organizations.controller.ts:102-155`
- Modify: `backend/src/modules/organizations/dto/model-settings.dto.ts`
- Modify: `backend/src/core/enums.ts`
- Modify: `backend/src/core/audit/audit-events.ts`
- Modify: `backend/src/agent/orchestration/agent-workflow.ts:1143`

**Interfaces:**
- Consumes: `FailoverModelProvider`, `FailoverMember` (Task 3); the schema columns (Task 2); `PublicModelSettings.warning` (Task 1).
- Produces, for Tasks 5-6:
  - `ModelSettingsService.list(organizationId): Promise<ModelProviderList>` where `ModelProviderList = { rows: PublicModelProviderRow[]; fromEnvironment: boolean; environmentSummary: string | null }`
  - `PublicModelProviderRow = { id: string; priority: number; label: string; enabled: boolean; providerId: ModelProviderId; model: string | null; baseUrl: string | null; hasApiKey: boolean; structuredOutputs: boolean | null; warning: string | null; updatedAt: string | null }`
  - `ModelSettingsService.addRow(organizationId, userId, input): Promise<PublicModelProviderRow>`
  - `ModelSettingsService.updateRow(organizationId, rowId, userId, input): Promise<PublicModelProviderRow>`
  - `ModelSettingsService.removeRow(organizationId, rowId, userId): Promise<void>`
  - `ModelSettingsService.reorder(organizationId, userId, orderedIds: string[]): Promise<ModelProviderList>`
  - `ModelSettingsService.resolveChain(organizationId): Promise<ResolvedModelChain>` where `ResolvedModelChain = { members: ResolvedModelSettings[]; revision: number; fromEnvironment: boolean }` and each member gains `id`, `priority`, `label`, `structuredOutputs`
  - `ModelProviderResolver.testRow(organizationId, rowId, userId): Promise<ProviderTestResult>`
  - `ModelProviderResolver.testChain(organizationId, userId): Promise<ProviderTestResult[]>`
  - `ModelProviderResolver.discoverModels(baseUrl, apiKey?): Promise<string[]>`
  - `ProviderTestResult` gains `rowId: string | null`, `priority: number`, `label: string`
  - Endpoints: `GET|POST /organizations/:organizationId/model-providers`, `PATCH|DELETE /organizations/:organizationId/model-providers/:rowId`, `PUT /organizations/:organizationId/model-providers/order`, `POST /organizations/:organizationId/model-providers/test`, `POST /organizations/:organizationId/model-providers/:rowId/test`, `POST /organizations/:organizationId/model-providers/discover-models`

- [ ] **Step 1: Add the presets and the audit event**

In `backend/src/core/enums.ts`, after `MODEL_PROVIDERS_REQUIRING_KEY`:

```typescript
/**
 * Ready-made configurations, offered in the portal (ADR-023 extended).
 *
 * Presets fill a form; they are not provider kinds, and every one of them stores
 * as an existing MODEL_PROVIDER_ID. The value of naming them is the two fields
 * nobody can guess: which base URL an endpoint uses, and whether it enforces a
 * JSON schema itself.
 *
 * 9router and Hermes share one entry because on the deployment this was written
 * for they are the same process, serving http://127.0.0.1:20128/v1 (ADR-023).
 * Two entries with an identical URL would suggest a difference that is not there.
 */
export const MODEL_PROVIDER_PRESETS = [
  {
    id: 'local-gateway',
    label: 'Local gateway (9router / Hermes)',
    providerId: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:20128/v1',
    model: '',
    structuredOutputs: true,
    detail: 'A gateway on this machine. Load its model list rather than guessing a name.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    providerId: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    // DeepSeek rejects response_format json_schema and accepts only json_object.
    structuredOutputs: false,
    detail: 'Enforces JSON objects rather than schemas, so schema checking falls to the SDK.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    providerId: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    structuredOutputs: true,
    detail: 'OpenAI directly.',
  },
  {
    id: 'groq',
    label: 'Groq',
    providerId: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    structuredOutputs: true,
    detail: 'Open-weight models, served fast.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic direct',
    providerId: 'anthropic',
    baseUrl: '',
    model: 'claude-sonnet-4-5',
    structuredOutputs: true,
    detail: 'Claude models, called directly rather than through a gateway.',
  },
] as const;
```

In `backend/src/core/audit/audit-events.ts`, after `MODEL_PROVIDER_TESTED`:

```typescript
  MODEL_PROVIDER_REORDERED: 'model_provider.reordered',
```

- [ ] **Step 2: Write the failing service tests**

Replace the `describe('validation, before anything is stored', ...)` block in `backend/src/modules/organizations/model-settings.spec.ts` with one that calls the new method, and add the priority tests. The existing validation assertions are kept — they are still the rules — but move to `addRow`:

```typescript
  describe('validation, before anything is stored', () => {
    const service = build();

    // Reaching the database would mean the refusal came too late to be certain
    // nothing was written, so these assert the message rather than mock storage.
    const add = (input: Parameters<ModelSettingsService['addRow']>[2]) =>
      service.addRow('org-1', 'user-1', input);

    it('refuses a provider that is not offered', async () => {
      await expect(add({ providerId: 'gemini' as never })).rejects.toThrow(BadRequestException);
    });

    it('refuses openai-compatible with no base URL', async () => {
      await expect(
        add({ providerId: 'openai-compatible', apiKey: 'sk-test-key' }),
      ).rejects.toThrow(/needs a base URL/);
    });

    it('refuses a base URL that is not a URL', async () => {
      await expect(
        add({ providerId: 'openai-compatible', apiKey: 'sk-x', baseUrl: 'api.example.com' }),
      ).rejects.toThrow(/not a valid URL/);
    });

    it('refuses a plaintext endpoint, because the prompt carries source code', async () => {
      await expect(
        add({
          providerId: 'openai-compatible',
          apiKey: 'sk-x',
          baseUrl: 'http://api.example.com/v1',
        }),
      ).rejects.toThrow(/must use https/);
    });

    it('refuses an over-long model name', async () => {
      await expect(
        add({ providerId: 'anthropic', apiKey: 'sk-x', model: 'm'.repeat(201) }),
      ).rejects.toThrow(/longer than 200/);
    });

    it('refuses an over-long key rather than sealing it', async () => {
      await expect(
        add({ providerId: 'anthropic', apiKey: 'k'.repeat(8193) }),
      ).rejects.toThrow(/longer than 8192/);
    });

    it('refuses a label longer than the column', async () => {
      await expect(
        add({ providerId: 'anthropic', apiKey: 'sk-x', label: 'L'.repeat(121) }),
      ).rejects.toThrow(/longer than 120/);
    });
  });
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd backend && npx jest src/modules/organizations/model-settings.spec.ts`
Expected: FAIL — `service.addRow is not a function`.

- [ ] **Step 4: Rewrite the service around rows**

In `backend/src/modules/organizations/model-settings.service.ts`:

Replace the `PublicModelSettings` interface with `PublicModelProviderRow` and `ModelProviderList` exactly as named in the Interfaces block above. Keep `ResolvedModelSettings` and extend it with `id: string | null`, `priority: number`, `label: string`, `structuredOutputs: boolean | null`.

Replace `write`/`clear` with `addRow`, `updateRow`, `removeRow`, `reorder`. The key handling inside them is unchanged from the current `write` (lines 175-200) — seal through `this.secrets.write`, destroy the replaced ref only after the new one is sealed, clear on empty string or `mock`. Keep `assertValid`, adding the label length check. Keep `keylessLoopbackWarning` from Task 1.

Replace `resolve` with `resolveChain`:

```typescript
  /**
   * The ordered chain the resolver builds providers from.
   *
   * Disabled rows are left out here rather than filtered later, so "what will be
   * called" has one answer. An organisation with no enabled rows falls back to
   * the environment, which is what it did before this table held more than one.
   */
  async resolveChain(organizationId: string): Promise<ResolvedModelChain> {
    const rows = await this.database.db
      .select()
      .from(organizationModelSettings)
      .where(eq(organizationModelSettings.organizationId, organizationId))
      .orderBy(organizationModelSettings.priority);

    const enabled = rows.filter((row) => row.enabled);

    if (enabled.length === 0) {
      return {
        members: [
          {
            id: null,
            priority: 1,
            label: 'Server configuration',
            providerId: this.config.ai.provider,
            model: this.config.ai.model ?? null,
            baseUrl: this.config.ai.baseUrl ?? null,
            structuredOutputs: null,
            // Null, not the key: an environment-configured provider reads its key
            // from configuration, and this field is a secret_records reference.
            secretRef: null,
            revision: 0,
            fromEnvironment: true,
          },
        ],
        revision: 0,
        fromEnvironment: true,
      };
    }

    return {
      members: enabled.map((row) => ({
        id: row.id,
        priority: row.priority,
        label: row.label ?? row.providerId,
        providerId: row.providerId as ModelProviderId,
        model: row.model,
        baseUrl: row.baseUrl,
        structuredOutputs: row.structuredOutputs,
        secretRef: row.secretRef,
        revision: row.revision,
        fromEnvironment: false,
      })),
      // Summed rather than maxed: an added or removed row must change this, and
      // both leave the surviving rows' own revisions untouched.
      revision: enabled.reduce((total, row) => total + row.revision, 0),
      fromEnvironment: false,
    };
  }
```

`reorder` assigns priorities from the given order. Write the new priorities in one transaction, offset first to dodge the unique index:

```typescript
  /**
   * Rewrites priorities to match the given order.
   *
   * Two passes inside one transaction: every row is moved to a high temporary
   * priority first, then to its final one. A single pass trips the unique index
   * the moment two rows swap places.
   */
  async reorder(
    organizationId: string,
    userId: string,
    orderedIds: readonly string[],
  ): Promise<ModelProviderList> {
    const rows = await this.database.db
      .select({ id: organizationModelSettings.id })
      .from(organizationModelSettings)
      .where(eq(organizationModelSettings.organizationId, organizationId));

    const known = new Set(rows.map((row) => row.id));
    if (orderedIds.length !== known.size || orderedIds.some((id) => !known.has(id))) {
      throw new BadRequestException(
        'The new order must list every configured provider exactly once.',
      );
    }

    await this.database.db.transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(organizationModelSettings)
          .set({ priority: 1000 + index })
          .where(eq(organizationModelSettings.id, id));
      }

      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(organizationModelSettings)
          .set({
            priority: index + 1,
            revision: sql`${organizationModelSettings.revision} + 1`,
            updatedByUserId: userId,
            updatedAt: new Date(),
          })
          .where(eq(organizationModelSettings.id, id));
      }
    });

    await this.audit.record({
      event: AUDIT_EVENTS.MODEL_PROVIDER_REORDERED,
      organizationId,
      userId,
      metadata: { order: orderedIds },
    });

    return this.list(organizationId);
  }
```

`readApiKey` keeps its current body (lines 289-293) — it already takes a `ResolvedModelSettings` and needs no change.

- [ ] **Step 5: Run the service tests**

Run: `cd backend && npx jest src/modules/organizations/model-settings.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Build the chain in the resolver**

In `backend/src/agent/model/model-provider-resolver.ts`:

`forOrganization` calls `resolveChain`, builds each member, and wraps the list once:

```typescript
  async forOrganization(organizationId: string): Promise<ModelProvider> {
    const chain = await this.settings.resolveChain(organizationId);

    const cached = this.cache.get(organizationId);
    if (cached && cached.revision === chain.revision) return cached.provider;

    // Mock is not a chain: it calls nothing, so there is nothing to fail over
    // from, and wrapping it would suggest otherwise.
    if (chain.members.length === 1 && chain.members[0].providerId === 'mock') {
      const provider = new GuardedModelProvider(
        new ScriptedModelProvider(this.config),
        this.boundary,
      );
      this.cache.set(organizationId, { revision: chain.revision, provider });
      return provider;
    }

    const members: FailoverMember[] = [];
    for (const settings of chain.members) {
      members.push({
        priority: settings.priority,
        label: settings.label,
        provider: await this.buildOne(organizationId, settings),
      });
    }

    // Guarded on the outside, once. Every member is reached through this wrapper,
    // so there is no path to a provider that skips the AI data boundary — and a
    // refusal happens before any member is called rather than being failed over.
    const provider = new GuardedModelProvider(
      new FailoverModelProvider(members),
      this.boundary,
    );

    this.cache.set(organizationId, { revision: chain.revision, provider });
    return provider;
  }
```

Rename the existing private `build` to `buildOne`, returning the **unguarded** `AiSdkModelProvider` (the guard now lives outside the chain), and pass the row's structured-output setting:

```typescript
    const inner = new AiSdkModelProvider(this.config, {
      provider: settings.providerId as 'anthropic' | 'openai-compatible',
      model: settings.model ?? undefined,
      baseUrl: settings.baseUrl ?? undefined,
      apiKey: apiKey ?? '',
      structuredOutputs: settings.structuredOutputs ?? undefined,
    });
```

Add `testRow`, `testChain` and `discoverModels`. `testRow` keeps the existing probe (the prompt at lines 147-158 and `CONNECTIVITY_SCHEMA` are unchanged) and wraps the single member in a `GuardedModelProvider` so the test path is guarded exactly like the real one. `testChain` maps `resolveChain().members` through `testRow` and returns the array. `discoverModels`:

```typescript
  /**
   * The model names an OpenAI-compatible endpoint serves.
   *
   * Worth an endpoint because the names are unguessable — the gateway on this
   * host serves Paket-Hemat, Banyak-duit and ag/claude-sonnet-4-6 — and a wrong
   * name comes back as HTTP 400 or 404, which reads like a different problem
   * entirely. Called from the server because the browser has no key and must not
   * be given one.
   */
  async discoverModels(baseUrl: string, apiKey?: string): Promise<string[]> {
    const url = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(
        `The endpoint answered HTTP ${response.status} when asked for its model list.`,
      );
    }

    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string');
  }
```

Import `FailoverModelProvider` and `FailoverMember` from `./failover-model-provider`.

- [ ] **Step 7: Replace the controller endpoints**

In `backend/src/modules/organizations/organizations.controller.ts`, replace lines 102-155 with the six endpoints named in the Interfaces block. Authorisation is unchanged: `requireOrganizationMember` to read, `'admin'` to write and to test. Every write and every reorder calls `this.providers.invalidate(organizationId)` — the cached chain is keyed on the summed revision, and dropping it here means a change applies to the next task rather than whenever the revision is next read.

Route order matters: declare `POST :organizationId/model-providers/discover-models` **before** `POST :organizationId/model-providers/:rowId/test`, or `discover-models` is captured as a `rowId`.

Add the DTOs to `backend/src/modules/organizations/dto/model-settings.dto.ts`, following the existing `WriteModelSettingsDto` shape and its comment about `apiKey` being write-only. `ReorderModelProvidersDto` carries `@IsArray() @IsUUID('4', { each: true }) order!: string[]`. `DiscoverModelsDto` carries `baseUrl!: string` and an optional `apiKey?: string`.

- [ ] **Step 8: Fix the misrecorded provider on the failure path**

In `backend/src/agent/orchestration/agent-workflow.ts`, `failOnModelError` currently records `this.config.ai.provider` — the environment value — for an organisation whose provider came from the portal. Already wrong before failover; worse with it.

```typescript
    // The provider that actually failed, not the environment's. A
    // ModelProviderError names its own provider; anything else did not reach one.
    const attemptedProvider =
      error instanceof ModelProviderError ? error.provider : this.config.ai.provider;

    await this.modelCalls.record({
      taskId: snapshot.taskId,
      organizationId: snapshot.organizationId,
      operation,
      providerId: attemptedProvider,
      model: this.config.ai.model,
      calledExternalService: attemptedProvider !== 'mock',
```

- [ ] **Step 9: Full suite and typecheck**

Run: `cd backend && npx jest && npm run typecheck`
Expected: 510+ tests passing, typecheck clean.

- [ ] **Step 10: Verify against the real gateway**

```bash
cd backend && npm run db:migrate && cd .. && npm run dev
sleep 20
curl -s http://127.0.0.1:4000/api/v1/health
```

Then sign in to the portal, add a provider row for the local gateway with the real token from `.env`, and press Test. Expected: `ok: true`, with the model named and a duration in milliseconds — the gateway answers `{"status": "OK"}` to this exact probe, verified on 2026-09-04.

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/organizations backend/src/agent/model/model-provider-resolver.ts \
        backend/src/core/enums.ts backend/src/core/audit/audit-events.ts \
        backend/src/agent/orchestration/agent-workflow.ts
git commit -m "$(cat <<'MSG'
Configure, order and test a list of providers rather than one

The service, resolver and endpoints now speak rows: add, edit, remove, reorder,
test one, test the chain, and ask a gateway what models it serves. The guard
moves outside the chain, so the boundary is crossed once and a refusal cannot be
failed over.

Also fixes the failure path recording AI_PROVIDER as the provider that failed.
It was already wrong for any organisation configured through the portal; with a
chain it would have named an endpoint that was never called.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: The portal shows the list

**Files:**
- Modify: `frontend/lib/types.ts:372-398`
- Modify: `frontend/lib/api.ts:202-231`

**Interfaces:**
- Consumes: Task 4's endpoints and response shapes.
- Produces, for Task 6: `ModelProviderRow`, `ModelProviderList`, `ModelProviderPreset`, extended `ModelProviderTestResult`, and `api.organizations.{modelProviders, addModelProvider, updateModelProvider, removeModelProvider, reorderModelProviders, testModelProviderRow, testModelProviderChain, discoverModels}`.

- [ ] **Step 1: Replace the types**

In `frontend/lib/types.ts`, replace `ModelProviderSettings` (lines 380-389) and extend `ModelProviderTestResult`:

```typescript
/**
 * One configured provider (ADR-023 extended).
 *
 * The key is write-only across this boundary, so `hasApiKey` is all that is said
 * about it — there is no field here it could occupy, which is what makes that
 * guarantee structural rather than a habit.
 */
export interface ModelProviderRow {
  id: string;
  priority: number;
  label: string;
  enabled: boolean;
  providerId: ModelProviderId;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  /** Null follows the server default. False for DeepSeek, which rejects json_schema. */
  structuredOutputs: boolean | null;
  /** Set when the row is accepted but likely to fail, e.g. a keyless local gateway. */
  warning: string | null;
  updatedAt: string | null;
}

export interface ModelProviderList {
  rows: ModelProviderRow[];
  /** True when the list is empty and the server's own configuration is in use. */
  fromEnvironment: boolean;
  /** What that configuration is, for display. Null when rows are configured. */
  environmentSummary: string | null;
}

export interface ModelProviderPreset {
  id: string;
  label: string;
  providerId: ModelProviderId;
  baseUrl: string;
  model: string;
  structuredOutputs: boolean;
  detail: string;
}

export interface ModelProviderTestResult {
  ok: boolean;
  /** Null when the environment fallback was tested rather than a stored row. */
  rowId: string | null;
  priority: number;
  label: string;
  providerId: ModelProviderId;
  model: string;
  calledExternalService: boolean;
  message: string;
  durationMs: number;
}
```

- [ ] **Step 2: Replace the API client methods**

In `frontend/lib/api.ts`, replace the four `modelProvider*` methods (lines 202-231):

```typescript
    modelProviders: (organizationId: string) =>
      request<ModelProviderList>(`/organizations/${organizationId}/model-providers`),

    /**
     * Adds a provider. `apiKey` is write-only: no endpoint returns it, and there
     * is no response field it could arrive in.
     */
    addModelProvider: (
      organizationId: string,
      body: {
        label?: string;
        providerId: ModelProviderId;
        model?: string;
        baseUrl?: string;
        apiKey?: string;
        structuredOutputs?: boolean;
      },
    ) =>
      request<ModelProviderRow>(`/organizations/${organizationId}/model-providers`, {
        method: 'POST',
        body,
      }),

    /** Omit `apiKey` to keep the stored key; send an empty string to remove it. */
    updateModelProvider: (
      organizationId: string,
      rowId: string,
      body: {
        label?: string;
        enabled?: boolean;
        providerId?: ModelProviderId;
        model?: string;
        baseUrl?: string;
        apiKey?: string;
        structuredOutputs?: boolean | null;
      },
    ) =>
      request<ModelProviderRow>(
        `/organizations/${organizationId}/model-providers/${rowId}`,
        { method: 'PATCH', body },
      ),

    removeModelProvider: (organizationId: string, rowId: string) =>
      request<void>(`/organizations/${organizationId}/model-providers/${rowId}`, {
        method: 'DELETE',
      }),

    reorderModelProviders: (organizationId: string, order: string[]) =>
      request<ModelProviderList>(`/organizations/${organizationId}/model-providers/order`, {
        method: 'PUT',
        body: { order },
      }),

    testModelProviderRow: (organizationId: string, rowId: string) =>
      request<ModelProviderTestResult>(
        `/organizations/${organizationId}/model-providers/${rowId}/test`,
        { method: 'POST' },
      ),

    testModelProviderChain: (organizationId: string) =>
      request<ModelProviderTestResult[]>(
        `/organizations/${organizationId}/model-providers/test`,
        { method: 'POST' },
      ),

    /**
     * What models an endpoint serves. Goes through the server because the browser
     * has no key and must not be given one.
     */
    discoverModels: (organizationId: string, body: { baseUrl: string; apiKey?: string }) =>
      request<{ models: string[] }>(
        `/organizations/${organizationId}/model-providers/discover-models`,
        { method: 'POST', body },
      ),
```

Update the type import block at the top of the file: `ModelProviderSettings` is gone, `ModelProviderList` and `ModelProviderRow` take its place.

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: FAIL, and only in `app/settings/page.tsx` — it still uses the removed type. Task 6 fixes it. Confirm no other file is named in the errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/api.ts
git commit -m "$(cat <<'MSG'
Teach the portal client about a list of providers

Types and client methods for the row endpoints. The key stays write-only: no
response shape here has a field it could arrive in, which is what makes that a
structural guarantee rather than a habit.

The settings page does not compile against these yet; the next commit rewrites
it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: The settings page

**Files:**
- Modify: `frontend/app/settings/page.tsx` (rewrite the provider section)

**Interfaces:**
- Consumes: everything Task 5 produced.
- Produces: nothing downstream.

- [ ] **Step 1: Rewrite the provider section**

Replace the single form with the ordered list. The layout, from the spec:

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
│                                                                  │
│  [ + Add provider ]                    [ Test the whole chain ]  │
│                                                                  │
│  With an empty list the server configuration is used:            │
│  openai-compatible / cc/claude-sonnet-5                          │
└──────────────────────────────────────────────────────────────────┘
```

What each decision was, so it is not re-litigated while implementing:

- **Up/down buttons, not drag-and-drop.** Priority changes rarely, and drag-and-drop needs a dependency the project does not have (`frontend/package.json` lists only next, react, react-dom).
- **Rows are summaries; one expands at a time to edit.** Three full forms at once is unreadable. Hold `expandedId: string | null` in state.
- **Each row's test result renders inside that row**, keyed by `rowId` from the result. This is why `priority` and `label` are on the result shape.
- **The environment fallback is a line of text below the list, not a row.** It is not a database row, and rendering it as one would imply it can be deleted here.
- **Presets fill the expanded form.** Fetch them from the server or mirror `MODEL_PROVIDER_PRESETS`; if you mirror them, add a comment naming `backend/src/core/enums.ts` as the source so the two do not drift silently.
- **"Load models"** calls `api.organizations.discoverModels` with the row's base URL and typed key, and turns the model input into a `<select>` of what came back, with a free-text fallback — a gateway that does not serve `/v1/models` must still be configurable.
- **Non-admins** see the list, the warnings and the test results, and none of the edit controls. Keep the existing pattern at lines 362-367 and its wording.
- **`settings.warning`** from Task 1 renders per row, as `<Alert tone="warning">`.

Keep the second panel, "What the model is and is not given" (lines 371-390), exactly as it is. It describes the boundary, which none of this changes.

- [ ] **Step 2: Typecheck and build**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 3: Exercise it against the real gateway**

With the stack up (`npm run dev`), in the portal:

1. Add a row: preset "Local gateway", label "9router Paket-Hemat", paste the token from `.env`, press "Load models", pick `Paket-Hemat`, save.
2. Press Test on that row. Expected: green, naming the model and a duration.
3. Add a second row with a deliberately wrong token, label "broken fallback", priority 2.
4. Press "Test the whole chain". Expected: two results — row 1 green, row 2 reporting a rejected key.
5. Move row 2 above row 1 with the up arrow, reload the page, confirm the order held.
6. Move it back.

- [ ] **Step 4: Confirm failover actually fires**

Set row 1's token to something invalid, keep row 2 valid, and run a real task. Then:

```bash
DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$DB" -c "select provider_id, model, created_at from agent_model_calls order by created_at desc limit 3;"
```

Expected: the call is recorded against the provider that actually answered — row 2 — not row 1. This is the one check that proves the chain works end to end rather than merely compiling.

- [ ] **Step 5: Full suite**

Run: `cd backend && npx jest && npm run typecheck && cd ../frontend && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/settings/page.tsx
git commit -m "$(cat <<'MSG'
Show the provider chain as an ordered list

One form became a list: add, reorder, disable, test a row or the whole chain,
and ask a gateway for its model names rather than guessing them — this one
serves Paket-Hemat and Banyak-duit, which nobody would type by accident.

The environment fallback is a line of text rather than a fourth row. It is not a
database row, and showing it as one would suggest it can be deleted here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Self-review

**Spec coverage.** Each spec section maps to a task: schema → Task 2; failover behaviour → Task 3; test connection → Task 1 (the defect) and Task 4 (per-row and chain endpoints); Settings UI → Tasks 5-6; the `agent-workflow.ts:1143` fix → Task 4 Step 8; presets and model discovery → Task 4 Step 1 and Task 6. The spec's testing section maps to Task 3's spec file, Task 4's service tests, and Task 6 Step 4 — which covers the one thing no unit test can, that the chain fails over against a real endpoint.

**Type consistency.** `PublicModelProviderRow` is the row shape everywhere; `ModelProviderRow` is its frontend mirror with identical field names. `ResolvedModelChain.members` are `ResolvedModelSettings`, which `buildOne` consumes. `FailoverMember` is `{ priority, label, provider }` in Task 3's definition, its spec, and Task 4's construction.

**Known gap, deliberate.** Task 6 gives the settings page its layout, decisions and acceptance checks but not a full 400-line JSX listing. The page has no test framework in this project (`frontend/package.json` has no test runner), so the verification that matters is Steps 3-4 against the real gateway, which are written out in full.

## Out of scope

- Per-call round robin, weighting, cooldown.
- Per-project provider overrides.
- Hermes as an agentic learning service — phase two, its own spec.
- Odoo Online, which has no local code.
