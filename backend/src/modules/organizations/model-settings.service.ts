import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { organizationModelSettings } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import {
  isLoopbackUrl,
  MODEL_PROVIDER_IDS,
  MODEL_PROVIDERS_REQUIRING_KEY,
  type ModelProviderId,
} from '../../core/enums';

/** What an organisation has configured, as the resolver needs it. */
export interface ResolvedModelSettings {
  /** Null for the environment fallback, which is not a stored row. */
  readonly id: string | null;
  readonly priority: number;
  readonly label: string;
  readonly providerId: ModelProviderId;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly structuredOutputs: boolean | null;
  readonly secretRef: string | null;
  /** Changes on every write, so a cached provider can be invalidated. */
  readonly revision: number;
  /** True when this came from the environment rather than from a stored row. */
  readonly fromEnvironment: boolean;
}

/** The ordered chain the resolver builds providers from. */
export interface ResolvedModelChain {
  readonly members: readonly ResolvedModelSettings[];
  /** Summed across the members that will actually be called. */
  readonly revision: number;
  readonly fromEnvironment: boolean;
}

/**
 * One provider row as the portal is shown it. Deliberately has no field that
 * could carry the key.
 *
 * The key is write-only across this boundary: `hasApiKey` is the only thing said
 * about it, and there is no endpoint that returns it. That is not politeness, it
 * is the requirement that backend secrets never reach the frontend - and the way
 * to satisfy it reliably is for the shape sent to the browser to have nowhere to
 * put one.
 */
export interface PublicModelProviderRow {
  readonly id: string;
  readonly priority: number;
  readonly label: string;
  readonly enabled: boolean;
  readonly providerId: ModelProviderId;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly hasApiKey: boolean;
  readonly structuredOutputs: boolean | null;
  /**
   * Set when the stored configuration is accepted but likely to fail: a loopback
   * endpoint with no key. Null when there is nothing to say.
   */
  readonly warning: string | null;
  readonly updatedAt: string | null;
}

/** An organisation's configured providers, or the environment it falls back to. */
export interface ModelProviderList {
  readonly rows: readonly PublicModelProviderRow[];
  readonly fromEnvironment: boolean;
  readonly environmentSummary: string | null;
}

export interface AddModelProviderInput {
  readonly providerId: ModelProviderId;
  readonly model?: string | null;
  readonly baseUrl?: string | null;
  /** Absent or empty means no key is stored for the new row. */
  readonly apiKey?: string;
  readonly label?: string | null;
  readonly structuredOutputs?: boolean | null;
  /** Defaults to true: a row is part of the chain unless told otherwise. */
  readonly enabled?: boolean;
}

export interface UpdateModelProviderInput {
  readonly providerId?: ModelProviderId;
  readonly model?: string | null;
  readonly baseUrl?: string | null;
  /**
   * Absent means "keep the key already stored", which is what a person editing
   * the model name expects. An explicit empty string clears it.
   */
  readonly apiKey?: string;
  readonly label?: string | null;
  readonly structuredOutputs?: boolean | null;
  readonly enabled?: boolean;
}

/** The fields `assertValid` needs, whichever of addRow/updateRow is calling it. */
interface ValidatableProviderInput {
  readonly providerId: ModelProviderId;
  readonly model?: string | null;
  readonly baseUrl?: string | null;
  readonly apiKey?: string;
  readonly label?: string | null;
}

type StoredRow = typeof organizationModelSettings.$inferSelect;

/**
 * The organisation's model provider configuration (ADR-023, extended to a list).
 *
 * Exists so that "which AIs are tried, in what order, and with whose key" is one
 * screen a person can change, instead of environment variables and a restart.
 * The environment remains the fallback, which keeps single-tenant deployments
 * working exactly as before.
 */
@Injectable()
export class ModelSettingsService {
  private readonly logger = new Logger(ModelSettingsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Every configured row, in the shape the portal may see. */
  async list(organizationId: string): Promise<ModelProviderList> {
    const rows = await this.database.db
      .select()
      .from(organizationModelSettings)
      .where(eq(organizationModelSettings.organizationId, organizationId))
      .orderBy(organizationModelSettings.priority);

    if (rows.length === 0) {
      return {
        rows: [],
        fromEnvironment: true,
        environmentSummary:
          this.config.ai.provider + (this.config.ai.model ? `/${this.config.ai.model}` : ''),
      };
    }

    return {
      rows: rows.map((row) => this.toPublicRow(row)),
      fromEnvironment: false,
      environmentSummary: null,
    };
  }

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

  /**
   * Adds a provider row, sealing the key through the secrets provider.
   *
   * The key never lands in this table, never enters an audit payload and is
   * never returned. The audit row records that a key was set and by whom, which
   * is the part anyone reviewing the trail actually needs.
   */
  async addRow(
    organizationId: string,
    userId: string,
    input: AddModelProviderInput,
  ): Promise<PublicModelProviderRow> {
    this.assertValid(input);

    const keySupplied = typeof input.apiKey === 'string' && input.apiKey.length > 0;

    // Refused rather than stored half-configured: a provider that calls out with
    // no key produces a failure on the next task, at which point the person who
    // set it is gone and someone else is reading a stack trace.
    // A gateway on this machine may legitimately have no key - ollama and
    // llama.cpp have none to give - so the requirement is about reaching a third
    // party, not about the provider's name. Hermes and most local gateways do
    // authenticate, and say so plainly when a key is missing.
    const reachesAThirdParty =
      MODEL_PROVIDERS_REQUIRING_KEY.includes(input.providerId) &&
      !isLoopbackUrl(normalise(input.baseUrl));

    if (reachesAThirdParty && !keySupplied) {
      throw new BadRequestException(
        `${input.providerId} calls an external service, so it needs an API key. ` +
          'Enter one to save this configuration.',
      );
    }

    let secretRef: string | null = null;
    if (keySupplied) {
      const written = await this.secrets.write({
        organizationId,
        projectId: null,
        purpose: `model-api-key-${input.providerId}`,
        value: input.apiKey as string,
      });
      secretRef = written.ref;
    }

    const nextPriority = await this.nextPriority(organizationId);

    const [row] = await this.database.db
      .insert(organizationModelSettings)
      .values({
        organizationId,
        priority: nextPriority,
        label: normalise(input.label),
        enabled: input.enabled ?? true,
        providerId: input.providerId,
        model: normalise(input.model),
        baseUrl: normalise(input.baseUrl),
        structuredOutputs: input.structuredOutputs ?? null,
        secretRef,
        updatedByUserId: userId,
        updatedAt: new Date(),
      })
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.MODEL_PROVIDER_CONFIGURED,
      organizationId,
      userId,
      metadata: {
        rowId: row.id,
        priority: row.priority,
        providerId: input.providerId,
        model: row.model,
        baseUrl: row.baseUrl,
        // Named without "key" in them on purpose: the audit redaction filter
        // matches on field names, and it blanked these booleans when they were
        // called apiKeyChanged and apiKeyPresent. The filter was right to; the
        // fix is a name that describes the fact rather than the secret.
        credentialStored: secretRef !== null,
      },
    });

    this.logger.log(
      `Organisation ${organizationId}: added model provider row ${row.id} ` +
        `(priority ${row.priority}, ${input.providerId})` +
        (keySupplied ? ', with a key' : ''),
    );

    return this.toPublicRow(row);
  }

  /**
   * Edits a stored row. Unset fields keep their current value; `apiKey` is the
   * one exception, where an explicit empty string clears the stored key.
   */
  async updateRow(
    organizationId: string,
    rowId: string,
    userId: string,
    input: UpdateModelProviderInput,
  ): Promise<PublicModelProviderRow> {
    const existing = await this.storedRow(organizationId, rowId);
    if (!existing) {
      throw new NotFoundException('That model provider row does not belong to this organisation.');
    }

    const mergedProviderId = input.providerId ?? (existing.providerId as ModelProviderId);
    const mergedModel = input.model !== undefined ? input.model : existing.model;
    const mergedBaseUrl = input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl;
    const mergedLabel = input.label !== undefined ? input.label : existing.label;

    this.assertValid({
      providerId: mergedProviderId,
      model: mergedModel,
      baseUrl: mergedBaseUrl,
      apiKey: input.apiKey,
      label: mergedLabel,
    });

    const keySupplied = typeof input.apiKey === 'string' && input.apiKey.length > 0;
    const keyCleared = input.apiKey === '';

    const reachesAThirdParty =
      MODEL_PROVIDERS_REQUIRING_KEY.includes(mergedProviderId) &&
      !isLoopbackUrl(normalise(mergedBaseUrl));

    if (reachesAThirdParty && !keySupplied && (keyCleared || !existing.secretRef)) {
      throw new BadRequestException(
        `${mergedProviderId} calls an external service, so it needs an API key. ` +
          'Enter one to save this configuration.',
      );
    }

    let secretRef = existing.secretRef;

    if (keySupplied) {
      const written = await this.secrets.write({
        organizationId,
        projectId: null,
        purpose: `model-api-key-${mergedProviderId}`,
        value: input.apiKey as string,
      });
      secretRef = written.ref;

      // Destroyed only after the replacement is sealed, so a failure mid-way
      // leaves the old key working rather than leaving the row with none.
      if (existing.secretRef && existing.secretRef !== secretRef) {
        await this.secrets.destroy(existing.secretRef).catch((error: Error) => {
          this.logger.warn(`Could not destroy the replaced key: ${error.message}`);
        });
      }
    } else if (keyCleared || mergedProviderId === 'mock') {
      if (existing.secretRef) {
        await this.secrets.destroy(existing.secretRef).catch(() => undefined);
      }
      secretRef = null;
    }

    const [row] = await this.database.db
      .update(organizationModelSettings)
      .set({
        providerId: mergedProviderId,
        model: normalise(mergedModel),
        baseUrl: normalise(mergedBaseUrl),
        label: normalise(mergedLabel),
        enabled: input.enabled ?? existing.enabled,
        structuredOutputs:
          input.structuredOutputs !== undefined ? input.structuredOutputs : existing.structuredOutputs,
        secretRef,
        // Bumped in SQL rather than read-then-written, so two concurrent saves
        // cannot land on the same revision and share a cached provider.
        revision: sql`${organizationModelSettings.revision} + 1`,
        updatedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(eq(organizationModelSettings.id, rowId))
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.MODEL_PROVIDER_CONFIGURED,
      organizationId,
      userId,
      metadata: {
        rowId: row.id,
        priority: row.priority,
        providerId: row.providerId,
        model: row.model,
        baseUrl: row.baseUrl,
        credentialReplaced: keySupplied,
        credentialStored: secretRef !== null,
      },
    });

    this.logger.log(
      `Organisation ${organizationId}: updated model provider row ${row.id}` +
        (keySupplied ? ', with a new key' : ''),
    );

    return this.toPublicRow(row);
  }

  /**
   * Removes a row, destroying the key stored against it.
   *
   * Removing the last row is not a special case here: `resolveChain` already
   * falls back to the environment once there are no enabled rows left.
   */
  async removeRow(organizationId: string, rowId: string, userId: string): Promise<void> {
    const existing = await this.storedRow(organizationId, rowId);
    if (!existing) {
      throw new NotFoundException('That model provider row does not belong to this organisation.');
    }

    if (existing.secretRef) {
      await this.secrets.destroy(existing.secretRef).catch((error: Error) => {
        this.logger.warn(`Could not destroy the stored key: ${error.message}`);
      });
    }

    await this.database.db
      .delete(organizationModelSettings)
      .where(
        and(
          eq(organizationModelSettings.id, rowId),
          eq(organizationModelSettings.organizationId, organizationId),
        ),
      );

    await this.audit.record({
      event: AUDIT_EVENTS.MODEL_PROVIDER_CLEARED,
      organizationId,
      userId,
      metadata: { rowId, providerId: existing.providerId, priority: existing.priority },
    });
  }

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
          .where(
            and(
              eq(organizationModelSettings.id, id),
              eq(organizationModelSettings.organizationId, organizationId),
            ),
          );
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
          .where(
            and(
              eq(organizationModelSettings.id, id),
              eq(organizationModelSettings.organizationId, organizationId),
            ),
          );
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

  /**
   * Unseals the key for a provider that is about to be built.
   *
   * The one place the plaintext exists, and the reason the method is named for
   * what it is: any new caller has to justify itself. The value must not be
   * logged, returned or put in an audit payload.
   */
  async readApiKey(settings: ResolvedModelSettings): Promise<string | undefined> {
    if (settings.fromEnvironment) return this.config.ai.apiKey;
    if (!settings.secretRef) return undefined;
    return this.secrets.read(settings.secretRef);
  }

  private async nextPriority(organizationId: string): Promise<number> {
    const rows = await this.database.db
      .select({ priority: organizationModelSettings.priority })
      .from(organizationModelSettings)
      .where(eq(organizationModelSettings.organizationId, organizationId));

    return rows.reduce((max, row) => Math.max(max, row.priority), 0) + 1;
  }

  // Both the query and the JS check exist on purpose: the query is the backstop
  // for a call site added later, the JS check is what turns a foreign row into
  // `undefined` for the callers that exist now.
  private async storedRow(organizationId: string, rowId: string): Promise<StoredRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(organizationModelSettings)
      .where(
        and(
          eq(organizationModelSettings.id, rowId),
          eq(organizationModelSettings.organizationId, organizationId),
        ),
      )
      .limit(1);

    return row && row.organizationId === organizationId ? row : undefined;
  }

  private toPublicRow(row: StoredRow): PublicModelProviderRow {
    const hasApiKey = row.secretRef !== null;

    return {
      id: row.id,
      priority: row.priority,
      label: row.label ?? row.providerId,
      enabled: row.enabled,
      providerId: row.providerId as ModelProviderId,
      model: row.model,
      baseUrl: row.baseUrl,
      hasApiKey,
      structuredOutputs: row.structuredOutputs,
      warning: this.keylessLoopbackWarning(row.baseUrl, hasApiKey),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }

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

  private assertValid(input: ValidatableProviderInput): void {
    if (!MODEL_PROVIDER_IDS.includes(input.providerId)) {
      throw new BadRequestException(
        `providerId must be one of: ${MODEL_PROVIDER_IDS.join(', ')}`,
      );
    }

    // The URL is where a mistake is most likely and most confusing: an endpoint
    // that does not resolve produces a failure at task time, far from here.
    if (input.providerId === 'openai-compatible') {
      const baseUrl = normalise(input.baseUrl);
      if (!baseUrl) {
        throw new BadRequestException(
          'An OpenAI-compatible endpoint needs a base URL. DeepSeek is ' +
            'https://api.deepseek.com, OpenAI https://api.openai.com/v1, ' +
            'Groq https://api.groq.com/openai/v1.',
        );
      }
      assertHttpsUrl(baseUrl);

      // Refused here rather than defaulted, because "openai-compatible" names a
      // wire format and not a vendor: DeepSeek, Groq and a self-hosted model share
      // no model names. Defaulting sent gpt-4o-mini to whatever endpoint was
      // configured, and a DeepSeek answering "Model Not Exist" reads exactly like
      // a rejected key.
      if (!normalise(input.model)) {
        throw new BadRequestException(
          'An OpenAI-compatible endpoint needs a model name. DeepSeek uses ' +
            'deepseek-chat, OpenAI gpt-4o-mini, Groq llama-3.3-70b-versatile.',
        );
      }
    }

    const model = normalise(input.model);
    if (model && model.length > 200) {
      throw new BadRequestException('model is longer than 200 characters');
    }

    if (typeof input.apiKey === 'string' && input.apiKey.length > 8192) {
      throw new BadRequestException('apiKey is longer than 8192 characters');
    }

    const label = normalise(input.label);
    if (label && label.length > 120) {
      throw new BadRequestException('label is longer than 120 characters');
    }
  }
}

function normalise(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Refuses a base URL that is not HTTPS, or that is not a URL at all.
 *
 * `http://localhost` is allowed because a self-hosted model on the same host is
 * a real deployment and there is no network to intercept. Any other plaintext
 * endpoint would send the prompt - which carries repository source - in the
 * clear, and the key with it.
 *
 * This is a transport rule and not an SSRF control: a private-network host over
 * https satisfies it, and a loopback port that is not a model gateway satisfies
 * the localhost branch. Anything fetching a caller-supplied URL needs its own
 * answer to "which host may this reach" - see `discoverModels`, which refuses
 * redirects for exactly that reason.
 */
export function assertHttpsUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException(`"${value}" is not a valid URL.`);
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackUrl(value))) {
    throw new BadRequestException(
      'The base URL must use https, because the prompt carries repository source ' +
        'code and the API key travels with it. Plain http is accepted only for ' +
        'localhost, where there is no network to intercept.',
    );
  }
}
