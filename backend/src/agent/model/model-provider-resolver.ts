import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { AiBoundaryService } from '../../core/ai-boundary/ai-boundary.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { isLoopbackUrl, type ModelProviderId } from '../../core/enums';
import {
  ModelSettingsService,
  type ResolvedModelSettings,
} from '../../modules/organizations/model-settings.service';
import { AiSdkModelProvider } from './ai-sdk-model-provider';
import { ScriptedModelProvider } from './scripted-model-provider';
import { GuardedModelProvider } from './guarded-model-provider';
import type { ModelProvider } from './model-provider.interface';

/**
 * A single-word answer, which is all a connectivity check needs.
 *
 * Structured rather than free text so the same code path as a real plan is
 * exercised: a provider that can complete but cannot produce structured output
 * would pass a plain-text check and fail every task.
 */
const CONNECTIVITY_SCHEMA = z.object({
  status: z.string().describe('The single word OK.'),
});

export interface ProviderTestResult {
  readonly ok: boolean;
  readonly providerId: ModelProviderId;
  readonly model: string;
  readonly calledExternalService: boolean;
  readonly message: string;
  readonly durationMs: number;
}

/**
 * Builds the model provider an organisation has configured (ADR-023).
 *
 * This replaces a provider bound once at boot from the environment. The reason
 * is a product one - "which AI, with whose key" should be a screen rather than a
 * restart - but the security property it must not lose is ADR-020's: the
 * unguarded providers are constructed here and immediately wrapped, and only the
 * wrapper is ever returned. `AiSdkModelProvider` is not exported from this
 * module, so there is no path to a provider that skips the AI data boundary.
 *
 * The plaintext API key exists for the duration of one build, inside this class,
 * and is handed to the SDK provider's constructor. It is not stored on this
 * object, not logged, and not returned.
 */
@Injectable()
export class ModelProviderResolver {
  private readonly logger = new Logger(ModelProviderResolver.name);

  /**
   * Built providers, keyed by organisation and the settings revision they were
   * built from. Caching matters because a provider construction reads and
   * unseals a secret, and a task makes several model calls; keying on the
   * revision is what makes a key change take effect on the next task rather than
   * on the next restart.
   */
  private readonly cache = new Map<string, { revision: number; provider: ModelProvider }>();

  constructor(
    private readonly settings: ModelSettingsService,
    private readonly boundary: AiBoundaryService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async forOrganization(organizationId: string): Promise<ModelProvider> {
    const resolved = await this.settings.resolve(organizationId);

    const cached = this.cache.get(organizationId);
    if (cached && cached.revision === resolved.revision) return cached.provider;

    const provider = await this.build(organizationId, resolved);
    this.cache.set(organizationId, { revision: resolved.revision, provider });

    return provider;
  }

  /**
   * Builds a provider and reports whether it can call out, without keeping it.
   *
   * Used by the "test this configuration" endpoint. Returns the guarded provider
   * so the caller cannot use it to bypass the boundary either.
   */
  async buildForTest(
    organizationId: string,
    settings: ResolvedModelSettings,
  ): Promise<ModelProvider> {
    return this.build(organizationId, settings);
  }

  /** Drops a cached provider, so the next call rebuilds it. */
  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  /**
   * Calls the configured provider once and reports whether it answered.
   *
   * Lives here rather than on ModelSettingsService because it is provider
   * construction plus one call, and construction is this class's job. The
   * settings service cannot do it without depending on this one, which depends on
   * it.
   *
   * The prompt carries no repository content, so this can be run before any
   * project is connected — which is the point. The alternative way to discover a
   * wrong key is a task that fails after cloning a repository and producing a
   * plan.
   *
   * A failure is returned, not thrown: "your key was rejected" is an answer to
   * the question asked, and the provider's own message is kept so that a wrong
   * URL and a wrong key read differently.
   */
  async test(organizationId: string, userId: string): Promise<ProviderTestResult> {
    const settings = await this.settings.resolve(organizationId);
    const startedAt = Date.now();

    if (settings.providerId === 'mock') {
      return {
        ok: true,
        providerId: 'mock',
        model: 'scripted-provider',
        calledExternalService: false,
        message:
          'No model is configured, so nothing was called. Plans are produced by ' +
          'the scripted provider, and every plan says so.',
        durationMs: 0,
      };
    }

    try {
      // Built fresh rather than taken from the cache: the point is to test what
      // is stored now, including a key saved a moment ago.
      const provider = await this.build(organizationId, settings);

      const result = await provider.generateStructured({
        system:
          'You are validating an API credential. Reply with the single word OK.',
        parts: [{ label: 'Check', content: 'Reply with OK.' }],
        schema: CONNECTIVITY_SCHEMA,
        schemaName: 'ConnectivityCheck',
        maxTokens: 64,
      });

      await this.audit.record({
        event: AUDIT_EVENTS.MODEL_PROVIDER_TESTED,
        organizationId,
        userId,
        metadata: {
          providerId: provider.id,
          model: provider.model,
          ok: true,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      });

      return {
        ok: true,
        providerId: settings.providerId,
        model: provider.model,
        calledExternalService: true,
        message:
          `${provider.id}/${provider.model} answered in ${result.usage.durationMs} ms ` +
          `(${result.usage.inputTokens} tokens in, ${result.usage.outputTokens} out).`,
        durationMs: result.usage.durationMs,
      };
    } catch (error) {
      const message = (error as Error).message;

      await this.audit.record({
        event: AUDIT_EVENTS.MODEL_PROVIDER_TESTED,
        organizationId,
        userId,
        // Recorded because it is diagnostic. It passes through the audit
        // redaction filter, which strips anything key-shaped.
        metadata: { providerId: settings.providerId, ok: false, error: message },
      });

      this.logger.warn(`Model provider test failed for ${organizationId}: ${message}`);

      return {
        ok: false,
        providerId: settings.providerId,
        model: settings.model ?? '(provider default)',
        calledExternalService: true,
        message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private async build(
    organizationId: string,
    settings: ResolvedModelSettings,
  ): Promise<ModelProvider> {
    if (settings.providerId === 'mock') {
      this.logger.log(
        `Organisation ${organizationId}: no model is called. Plans come from the ` +
          'scripted provider and every plan says so.',
      );
      return new GuardedModelProvider(new ScriptedModelProvider(this.config), this.boundary);
    }

    const apiKey = await this.settings.readApiKey(settings);

    // A gateway on this machine may legitimately have none - ollama and llama.cpp
    // have no key to give - so an absent key is only an error when the endpoint
    // is somewhere else. Anywhere else, reaching here means a secret was
    // destroyed underneath a stored row, which is worth failing loudly rather
    // than silently falling back to a provider the organisation did not choose.
    if (!apiKey && !isLoopbackUrl(settings.baseUrl)) {
      throw new Error(
        `No API key is available for organisation ${organizationId}, whose provider is ` +
          `"${settings.providerId}". Reconfigure the model provider.`,
      );
    }

    const inner = new AiSdkModelProvider(this.config, {
      provider: settings.providerId,
      model: settings.model ?? undefined,
      baseUrl: settings.baseUrl ?? undefined,
      // Empty only for a loopback endpoint, which the check above permitted. The
      // provider substitutes a placeholder there; a gateway that does
      // authenticate rejects it and says so, which is the useful failure.
      apiKey: apiKey ?? '',
    });

    this.logger.log(
      `Organisation ${organizationId}: model provider ${inner.id}/${inner.model}, ` +
        `guarded by the AI data boundary (${settings.fromEnvironment ? 'from the environment' : 'configured in the portal'})`,
    );

    return new GuardedModelProvider(inner, this.boundary);
  }
}
