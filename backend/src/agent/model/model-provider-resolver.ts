import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { AiBoundaryService } from '../../core/ai-boundary/ai-boundary.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { isLoopbackUrl, type ModelProviderId } from '../../core/enums';
import {
  ModelSettingsService,
  assertHttpsUrl,
  type ResolvedModelSettings,
} from '../../modules/organizations/model-settings.service';
import { AiSdkModelProvider } from './ai-sdk-model-provider';
import { ScriptedModelProvider } from './scripted-model-provider';
import { GuardedModelProvider } from './guarded-model-provider';
import { FailoverModelProvider, type FailoverMember } from './failover-model-provider';
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
  /** Null for the environment fallback, which is not a stored row. */
  readonly rowId: string | null;
  readonly priority: number;
  readonly label: string;
  readonly providerId: ModelProviderId;
  readonly model: string;
  readonly calledExternalService: boolean;
  readonly message: string;
  readonly durationMs: number;
}

/**
 * Builds the model provider(s) an organisation has configured (ADR-023, extended
 * to a failover chain).
 *
 * This replaces a provider bound once at boot from the environment. The reason
 * is a product one - "which AIs, in what order, with whose key" should be a
 * screen rather than a restart - but the security property it must not lose is
 * ADR-020's: the unguarded providers are constructed here and immediately
 * wrapped, and only the wrapper is ever returned. `AiSdkModelProvider` and
 * `ScriptedModelProvider` are not exported from this module, so there is no
 * path to a provider that skips the AI data boundary.
 *
 * `GuardedModelProvider` stays the outermost layer even with a chain: it wraps
 * the whole `FailoverModelProvider`, not each member, so the boundary is
 * crossed once and a refusal cannot be retried against the next provider.
 *
 * The plaintext API key exists for the duration of one build, inside this
 * class, and is handed to the SDK provider's constructor. It is not stored on
 * this object, not logged, and not returned.
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

  /** Drops a cached provider, so the next call rebuilds it. */
  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  /**
   * Calls one configured row's provider and reports whether it answered.
   *
   * Looks the row up in the resolved chain rather than adding a second query
   * path to the database: a row that is disabled, or that belongs to a
   * different organisation, is not in the chain and is reported as not found
   * rather than tested.
   */
  async testRow(organizationId: string, rowId: string, userId: string): Promise<ProviderTestResult> {
    const chain = await this.settings.resolveChain(organizationId);
    const member = chain.members.find((candidate) => candidate.id === rowId);

    if (!member) {
      throw new NotFoundException(
        'That model provider row is not enabled for this organisation.',
      );
    }

    return this.testMember(organizationId, member, userId);
  }

  /** Calls every member of the chain and reports on each, in priority order. */
  async testChain(organizationId: string, userId: string): Promise<ProviderTestResult[]> {
    const chain = await this.settings.resolveChain(organizationId);
    return Promise.all(
      chain.members.map((member) => this.testMember(organizationId, member, userId)),
    );
  }

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
    // The same transport rule the save path applies, for the same reason, and
    // reached through the same function: this fetch runs from the server, with the
    // server's network position, against a URL the caller chose.
    assertHttpsUrl(baseUrl);

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

  /**
   * Calls one member once and reports whether it answered.
   *
   * Shared by `testRow` and `testChain` so the probe itself - the prompt, the
   * schema, the guarding - exists in exactly one place. The prompt carries no
   * repository content, so this can be run before any project is connected —
   * which is the point. The alternative way to discover a wrong key is a task
   * that fails after cloning a repository and producing a plan.
   *
   * A failure is returned, not thrown: "your key was rejected" is an answer to
   * the question asked, and the provider's own message is kept so that a wrong
   * URL and a wrong key read differently.
   */
  private async testMember(
    organizationId: string,
    settings: ResolvedModelSettings,
    userId: string,
  ): Promise<ProviderTestResult> {
    const startedAt = Date.now();

    if (settings.providerId === 'mock') {
      return {
        ok: true,
        rowId: settings.id,
        priority: settings.priority,
        label: settings.label,
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
      // is stored now, including a key saved a moment ago. Guarded here exactly
      // like the real path, so the test cannot be used to reach an unguarded
      // provider either.
      const inner = await this.buildOne(organizationId, settings);
      const provider = new GuardedModelProvider(inner, this.boundary);

      const result = await provider.generateStructured({
        // Asks for the object, not for a word. The previous wording — "reply with
        // the single word OK" — was written assuming the provider would enforce
        // the schema itself. Against a gateway where the SDK falls back to JSON
        // mode, the model complied literally and answered `OK`, which then failed
        // schema validation: a working provider reported as a broken one.
        system:
          'You are validating an API credential. Respond with a JSON object and ' +
          'nothing else.',
        parts: [
          {
            label: 'Check',
            content: 'Respond with this exact JSON object: {"status": "OK"}',
          },
        ],
        schema: CONNECTIVITY_SCHEMA,
        schemaName: 'ConnectivityCheck',
        maxTokens: 64,
      });

      await this.audit.record({
        event: AUDIT_EVENTS.MODEL_PROVIDER_TESTED,
        organizationId,
        userId,
        metadata: {
          rowId: settings.id,
          priority: settings.priority,
          label: settings.label,
          providerId: provider.id,
          model: provider.model,
          ok: true,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      });

      return {
        ok: true,
        rowId: settings.id,
        priority: settings.priority,
        label: settings.label,
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
        metadata: {
          rowId: settings.id,
          priority: settings.priority,
          label: settings.label,
          providerId: settings.providerId,
          ok: false,
          error: message,
        },
      });

      this.logger.warn(
        `Model provider test failed for ${organizationId} (priority ${settings.priority}, ` +
          `${settings.label}): ${message}`,
      );

      return {
        ok: false,
        rowId: settings.id,
        priority: settings.priority,
        label: settings.label,
        providerId: settings.providerId,
        model: settings.model ?? '(provider default)',
        calledExternalService: true,
        message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * Builds one member's provider, unguarded.
   *
   * The guard now lives outside the whole chain (`forOrganization`) or outside
   * this single member (`testMember`), never here — a provider returned by this
   * method must not be handed to a caller directly.
   */
  private async buildOne(
    organizationId: string,
    settings: ResolvedModelSettings,
  ): Promise<ModelProvider> {
    if (settings.providerId === 'mock') {
      this.logger.log(
        `Organisation ${organizationId}: priority ${settings.priority} (${settings.label}) ` +
          'calls nothing. Plans come from the scripted provider and every plan says so.',
      );
      return new ScriptedModelProvider(this.config);
    }

    const apiKey = await this.settings.readApiKey(settings);

    // A gateway on this machine may legitimately have none - ollama and llama.cpp
    // have no key to give - so an absent key is only an error when the endpoint
    // is somewhere else. Anywhere else, reaching here means a secret was
    // destroyed underneath a stored row, which is worth failing loudly rather
    // than silently falling back to a provider the organisation did not choose.
    if (!apiKey && !isLoopbackUrl(settings.baseUrl)) {
      throw new Error(
        `No API key is available for organisation ${organizationId}, priority ` +
          `${settings.priority} (${settings.label}, "${settings.providerId}"). Reconfigure it.`,
      );
    }

    const inner = new AiSdkModelProvider(this.config, {
      provider: settings.providerId as 'anthropic' | 'openai-compatible',
      model: settings.model ?? undefined,
      baseUrl: settings.baseUrl ?? undefined,
      // Empty only for a loopback endpoint, which the check above permitted. The
      // provider substitutes a placeholder there; a gateway that does
      // authenticate rejects it and says so, which is the useful failure.
      apiKey: apiKey ?? '',
      structuredOutputs: settings.structuredOutputs ?? undefined,
    });

    this.logger.log(
      `Organisation ${organizationId}: priority ${settings.priority} (${settings.label}) ` +
        `provider ${inner.id}/${inner.model} ` +
        `(${settings.fromEnvironment ? 'from the environment' : 'configured in the portal'})`,
    );

    return inner;
  }
}
