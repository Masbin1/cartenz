import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
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
  readonly providerId: ModelProviderId;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly secretRef: string | null;
  /** Changes on every write, so a cached provider can be invalidated. */
  readonly revision: number;
  /** True when this came from the environment rather than from a stored row. */
  readonly fromEnvironment: boolean;
}

/**
 * What the portal is shown. Deliberately has no field that could carry the key.
 *
 * The key is write-only across this boundary: `hasApiKey` is the only thing said
 * about it, and there is no endpoint that returns it. That is not politeness, it
 * is the requirement that backend secrets never reach the frontend - and the way
 * to satisfy it reliably is for the shape sent to the browser to have nowhere to
 * put one.
 */
export interface PublicModelSettings {
  readonly providerId: ModelProviderId;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly hasApiKey: boolean;
  readonly callsExternalService: boolean;
  readonly fromEnvironment: boolean;
  readonly updatedAt: string | null;
}

export interface WriteModelSettingsInput {
  readonly providerId: ModelProviderId;
  readonly model?: string | null;
  readonly baseUrl?: string | null;
  /**
   * Absent means "keep the key already stored", which is what a person editing
   * the model name expects. An explicit empty string clears it.
   */
  readonly apiKey?: string;
}

/**
 * The organisation's model provider configuration (ADR-023).
 *
 * Exists so that "which AI is this, and with whose key" is one screen a person
 * can change, instead of two environment variables and a restart. The
 * environment remains the fallback, which keeps single-tenant deployments
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

  /**
   * What the resolver builds a provider from.
   *
   * Falls back to the environment when the organisation has configured nothing,
   * so an existing deployment behaves as it did before this table existed.
   */
  async resolve(organizationId: string): Promise<ResolvedModelSettings> {
    const [row] = await this.database.db
      .select()
      .from(organizationModelSettings)
      .where(eq(organizationModelSettings.organizationId, organizationId))
      .limit(1);

    if (!row) {
      return {
        providerId: this.config.ai.provider,
        model: this.config.ai.model ?? null,
        baseUrl: this.config.ai.baseUrl ?? null,
        // Null, not the key: an environment-configured provider reads its key
        // from configuration, and this field is a secret_records reference.
        secretRef: null,
        revision: 0,
        fromEnvironment: true,
      };
    }

    return {
      providerId: row.providerId as ModelProviderId,
      model: row.model,
      baseUrl: row.baseUrl,
      secretRef: row.secretRef,
      revision: row.revision,
      fromEnvironment: false,
    };
  }

  /** The same configuration, in the shape the portal may see. */
  async describe(organizationId: string): Promise<PublicModelSettings> {
    const resolved = await this.resolve(organizationId);

    const [row] = resolved.fromEnvironment
      ? []
      : await this.database.db
          .select({ updatedAt: organizationModelSettings.updatedAt })
          .from(organizationModelSettings)
          .where(eq(organizationModelSettings.organizationId, organizationId))
          .limit(1);

    return {
      providerId: resolved.providerId,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      hasApiKey: resolved.fromEnvironment
        ? Boolean(this.config.ai.apiKey)
        : resolved.secretRef !== null,
      callsExternalService: resolved.providerId !== 'mock',
      fromEnvironment: resolved.fromEnvironment,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Stores the configuration, sealing the key through the secrets provider.
   *
   * The key never lands in this table, never enters an audit payload and is
   * never returned. The audit row records that a key was set and by whom, which
   * is the part anyone reviewing the trail actually needs.
   */
  async write(
    organizationId: string,
    userId: string,
    input: WriteModelSettingsInput,
  ): Promise<PublicModelSettings> {
    this.assertValid(input);

    const existing = await this.storedRow(organizationId);
    const keySupplied = typeof input.apiKey === 'string' && input.apiKey.length > 0;
    const keyCleared = input.apiKey === '';

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

    if (reachesAThirdParty && !keySupplied && (keyCleared || !existing?.secretRef)) {
      throw new BadRequestException(
        `${input.providerId} calls an external service, so it needs an API key. ` +
          'Enter one to save this configuration.',
      );
    }

    let secretRef = existing?.secretRef ?? null;

    if (keySupplied) {
      const written = await this.secrets.write({
        organizationId,
        projectId: null,
        purpose: `model-api-key-${input.providerId}`,
        value: input.apiKey as string,
      });
      secretRef = written.ref;

      // Destroyed only after the replacement is sealed, so a failure mid-way
      // leaves the old key working rather than leaving the organisation with none.
      if (existing?.secretRef && existing.secretRef !== secretRef) {
        await this.secrets.destroy(existing.secretRef).catch((error: Error) => {
          this.logger.warn(`Could not destroy the replaced key: ${error.message}`);
        });
      }
    } else if (keyCleared || input.providerId === 'mock') {
      // Mock calls nothing, so holding a key for it would be storing a secret
      // with no purpose.
      if (existing?.secretRef) {
        await this.secrets.destroy(existing.secretRef).catch(() => undefined);
      }
      secretRef = null;
    }

    const values = {
      organizationId,
      providerId: input.providerId,
      model: normalise(input.model),
      baseUrl: normalise(input.baseUrl),
      secretRef,
      updatedByUserId: userId,
      updatedAt: new Date(),
    };

    await this.database.db
      .insert(organizationModelSettings)
      .values(values)
      .onConflictDoUpdate({
        target: organizationModelSettings.organizationId,
        set: {
          ...values,
          // Bumped in SQL rather than read-then-written, so two concurrent saves
          // cannot land on the same revision and share a cached provider.
          revision: sql`${organizationModelSettings.revision} + 1`,
        },
      });

    await this.audit.record({
      event: AUDIT_EVENTS.MODEL_PROVIDER_CONFIGURED,
      organizationId,
      userId,
      metadata: {
        providerId: input.providerId,
        model: values.model,
        baseUrl: values.baseUrl,
        // Named without "key" in them on purpose: the audit redaction filter
        // matches on field names, and it blanked these booleans when they were
        // called apiKeyChanged and apiKeyPresent. The filter was right to; the
        // fix is a name that describes the fact rather than the secret.
        credentialReplaced: keySupplied,
        credentialStored: secretRef !== null,
      },
    });

    this.logger.log(
      `Model provider for organisation ${organizationId} set to ${input.providerId}` +
        (values.model ? `/${values.model}` : '') +
        (keySupplied ? ', with a new key' : ''),
    );

    return this.describe(organizationId);
  }

  /**
   * Removes the organisation's configuration, returning it to the environment's.
   *
   * The stored key is destroyed. Reverting to the environment is deliberate
   * rather than leaving the organisation with no provider: "no configuration"
   * already has a defined meaning here, and inventing a second empty state would
   * make the resolver answer two questions instead of one.
   */
  async clear(organizationId: string, userId: string): Promise<PublicModelSettings> {
    const existing = await this.storedRow(organizationId);

    if (existing?.secretRef) {
      await this.secrets.destroy(existing.secretRef).catch((error: Error) => {
        this.logger.warn(`Could not destroy the stored key: ${error.message}`);
      });
    }

    await this.database.db
      .delete(organizationModelSettings)
      .where(eq(organizationModelSettings.organizationId, organizationId));

    await this.audit.record({
      event: AUDIT_EVENTS.MODEL_PROVIDER_CLEARED,
      organizationId,
      userId,
      metadata: { revertedTo: this.config.ai.provider },
    });

    return this.describe(organizationId);
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


  private async storedRow(organizationId: string) {
    const [row] = await this.database.db
      .select()
      .from(organizationModelSettings)
      .where(eq(organizationModelSettings.organizationId, organizationId))
      .limit(1);

    return row;
  }

  private assertValid(input: WriteModelSettingsInput): void {
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
 */
function assertHttpsUrl(value: string): void {
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
