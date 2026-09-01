import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject, generateText, jsonSchema, NoObjectGeneratedError, stepCountIs, tool } from 'ai';
import type { LanguageModel } from 'ai';
import type { AppConfig } from '../../core/config/configuration';
import { isLoopbackUrl } from '../../core/enums';
import { assemblePrompt, } from './prompt-assembly';
import {
  ModelProviderError,
  type ModelProvider,
  type ModelResult,
  type StructuredRequest,
  type ToolLoopOutcome,
  type ToolLoopRequest,
} from './model-provider.interface';

/**
 * The Vercel AI SDK provider (ADR-03, ADR-020).
 *
 * The SDK is the only vendor-specific thing in the codebase, and it is confined
 * to this file. Two bindings are supported: a hosted provider, and any
 * OpenAI-compatible endpoint - which is what serves a customer who forbids
 * external AI, since a self-hosted open-weight model behind that interface needs
 * no other change.
 *
 * This class is never bound directly. `ModelModule` wraps it in
 * `GuardedModelProvider`, so no content reaches the SDK without passing the AI
 * data boundary first.
 */
/**
 * The provider details this class needs, independent of where they came from.
 *
 * Introduced so an organisation's stored configuration can build a provider
 * without pretending to be an AppConfig (ADR-023). The environment remains the
 * default, which is what the second constructor argument being optional means.
 */
export interface ModelProviderSettings {
  readonly provider: 'anthropic' | 'openai-compatible';
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKey: string;
}

export class AiSdkModelProvider implements ModelProvider {
  private readonly logger = new Logger(AiSdkModelProvider.name);
  private readonly language: LanguageModel;

  readonly id: string;
  readonly model: string;
  readonly callsExternalService = true;

  constructor(
    private readonly config: AppConfig,
    settings?: ModelProviderSettings,
  ) {
    const effective: ModelProviderSettings = settings ?? {
      // Narrowed by the caller: ModelModule builds this class only when the
      // configured provider is not "mock".
      provider: config.ai.provider as 'anthropic' | 'openai-compatible',
      model: config.ai.model,
      baseUrl: config.ai.baseUrl,
      apiKey: config.ai.apiKey ?? '',
    };

    this.id = effective.provider;

    const model = effective.model?.trim() || defaultModelFor(effective.provider);
    if (!model) {
      throw new ModelProviderError(
        effective.provider,
        'An OpenAI-compatible endpoint needs a model name: the setting describes a wire ' +
          'format, not a vendor, so there is nothing sensible to default to. DeepSeek uses ' +
          'deepseek-chat, OpenAI gpt-4o-mini, Groq llama-3.3-70b-versatile.',
        false,
      );
    }

    this.model = model;
    this.language = this.resolveModel({ ...effective, model: this.model });
  }

  private resolveModel(settings: ModelProviderSettings & { model: string }): LanguageModel {
    // A gateway on this machine may have no key to give. The SDK still wants a
    // string, so it gets a placeholder that never leaves the loopback interface;
    // a gateway that does authenticate will reject it and say so, which is a
    // better failure than refusing to start.
    const local = isLoopbackUrl(settings.baseUrl);
    const apiKey = settings.apiKey || (local ? 'not-required-for-a-local-gateway' : '');

    if (!apiKey) {
      throw new ModelProviderError(
        settings.provider,
        `No API key is set for "${settings.provider}". Configure one in the ` +
          'organisation settings, set AI_API_KEY, or choose the mock provider to ' +
          'run without calling a model.',
      );
    }

    if (settings.provider === 'anthropic') {
      const anthropic = createAnthropic({
        apiKey,
        ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
      });
      return anthropic(settings.model);
    }

    if (!settings.baseUrl) {
      throw new ModelProviderError(
        settings.provider,
        'An openai-compatible provider needs a base URL, for example ' +
          'https://api.openai.com/v1.',
      );
    }

    const compatible = createOpenAICompatible({
      name: 'linkederp-self-hosted',
      apiKey,
      baseURL: settings.baseUrl,
      /**
       * The SDK assumes an unknown OpenAI-compatible endpoint cannot enforce a
       * JSON schema, and falls back to asking for JSON in the prompt. For a
       * schema as large as an implementation plan that is unreliable: the first
       * real attempt failed with "response did not match schema" while the same
       * gateway answered a `response_format: json_schema` request correctly.
       *
       * A plan is a structured value. Asking the endpoint to enforce the schema
       * is the whole point, and every gateway worth pointing this at supports it.
       * One that does not will fail loudly on the first task rather than
       * producing plans that nearly parse.
       */
      supportsStructuredOutputs: true,
      transformRequestBody: withExplicitStream,
    });
    return compatible(settings.model);
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<ModelResult<T>> {
    const nonce = randomUUID().slice(0, 8);
    const prompt = assemblePrompt(request.parts, nonce);
    const startedAt = Date.now();

    /**
     * The schema is passed opaquely and the result asserted back.
     *
     * generateObject infers its return type from the schema, and the plan schema
     * is nested deeply enough that TypeScript gives up (TS2589). Only the
     * compile-time inference is lost: the SDK still validates the model's output
     * against the schema at runtime, which is where it matters, and the caller's
     * own type comes from StructuredRequest<T>.
     */
    const options = {
      model: this.language,
      system: request.system,
      prompt: prompt.text,
      schema: request.schema,
      schemaName: request.schemaName,
      temperature: this.config.ai.temperature,
      maxOutputTokens: request.maxTokens ?? this.config.ai.maxOutputTokens,
      abortSignal: AbortSignal.timeout(this.config.ai.requestTimeoutMs),
    };

    // One retry, and only for NoObjectGeneratedError: the model answered but the
    // SDK could not validate the JSON against the schema. At temperature 0 that's
    // usually a one-off - the same request against the same gateway has come back
    // clean on the very next attempt in testing. Every other failure (a rejected
    // key, a missing model, a timeout) is not this and fails on the first try, as
    // before.
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // The cast is on the argument rather than the schema field: narrowing the
        // field alone makes TypeScript select a different overload and reject the
        // whole call.
        const result = (await generateObject(options as never)) as unknown as {
          object: unknown;
          usage?: { inputTokens?: number; outputTokens?: number };
        };

        return {
          value: result.object as T,
          usage: {
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            durationMs: Date.now() - startedAt,
          },
          boundaryFindings: [],
          redactionCount: 0,
          steps: 1,
        };
      } catch (error) {
        const canRetry = attempt < maxAttempts && NoObjectGeneratedError.isInstance(error);
        if (!canRetry) throw this.toProviderError(error);
        this.logger.warn(
          `${this.id}/${this.model} produced a response that did not match the schema; ` +
            `retrying (attempt ${attempt + 1}/${maxAttempts})`,
        );
      }
    }

    // Unreachable: the loop always returns or throws.
    throw new ModelProviderError(this.id, `${this.id} rejected the request.`, false);
  }

  async runToolLoop(request: ToolLoopRequest): Promise<ModelResult<ToolLoopOutcome>> {
    const nonce = randomUUID().slice(0, 8);
    const prompt = assemblePrompt(request.parts, nonce);
    const startedAt = Date.now();

    let toolCalls = 0;
    let haltReason: string | undefined;

    /**
     * The SDK's tools are thin adapters over the executor the agent supplied.
     * They decide nothing: whether a call may run is the permission validator's
     * answer, reached through `request.execute`.
     */
    const tools = Object.fromEntries(
      request.tools.map((definition) => [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.parameters),
          execute: async (args: unknown) => {
            // The budget is enforced here rather than trusted to stepCountIs: a
            // single step can contain several tool calls.
            if (toolCalls >= request.maxToolCalls) {
              haltReason = `the tool-call budget of ${request.maxToolCalls} was exhausted`;
              return { error: haltReason };
            }

            toolCalls += 1;
            const outcome = await request.execute(
              definition.name,
              (args ?? {}) as Record<string, unknown>,
            );

            if (outcome.halt) {
              haltReason = outcome.haltReason ?? 'the platform halted the loop';
            }

            return outcome.result;
          },
        }),
      ]),
    );

    try {
      const result = await generateText({
        model: this.language,
        system: request.system,
        prompt: prompt.text,
        tools,
        stopWhen: stepCountIs(request.maxSteps),
        temperature: this.config.ai.temperature,
        maxOutputTokens: request.maxTokens ?? this.config.ai.maxOutputTokens,
        abortSignal: AbortSignal.timeout(this.config.ai.requestTimeoutMs),
      });

      const steps = result.steps?.length ?? 1;
      if (steps >= request.maxSteps && !haltReason) {
        haltReason = `the step budget of ${request.maxSteps} was exhausted`;
      }

      return {
        value: { summary: result.text ?? '', toolCalls, haltReason },
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          durationMs: Date.now() - startedAt,
        },
        boundaryFindings: [],
        redactionCount: 0,
        steps,
      };
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  /**
   * Maps an SDK failure to a domain error.
   *
   * The distinction that matters is retryable or not: a rate limit or a timeout
   * is worth another attempt, an invalid key or a refused request is not, and
   * retrying the latter wastes a task's budget to reach the same answer.
   */
  private toProviderError(error: unknown): ModelProviderError {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : '';
    const status = readStatusCode(error);

    const retryable =
      name === 'TimeoutError' ||
      status === 429 ||
      (status !== undefined && status >= 500) ||
      /rate.?limit|overloaded|ECONNRESET|ETIMEDOUT/i.test(message);

    this.logger.error(
      `${this.id}/${this.model} failed${retryable ? ' (retryable)' : ''}` +
        `${status ? ` [HTTP ${status}]` : ''}: ${message}`,
    );

    return new ModelProviderError(this.id, this.explain(status, retryable, error), retryable);
  }

  /**
   * Turns a provider failure into something a person can act on.
   *
   * The prompt is never quoted: it has been through the AI data boundary but is
   * still the customer's source code. What is quoted is the provider's own error
   * *message* - "Model Not Exist", "Authentication Fails" - which is a fact about
   * the configuration and contains nothing of the request.
   *
   * This distinction is why the previous version was replaced. It suppressed
   * everything, and so reported a wrong model name, an expired key and an
   * unsupported feature identically as "the provider rejected the request",
   * which is true and useless.
   */
  private explain(status: number | undefined, retryable: boolean, error: unknown): string {
    const detail = readProviderMessage(error);
    const suffix = detail ? ` The provider said: ${detail}` : '';

    if (retryable) {
      return status === 429
        ? `${this.id} rate limited the request.${suffix}`
        : `${this.id} was unavailable.${suffix}`;
    }

    switch (status) {
      case 401:
        return `${this.id} rejected the API key.${suffix}`;
      case 403:
        return `The API key was accepted but is not allowed to use ${this.model}.${suffix}`;
      case 402:
        return `The ${this.id} account has no credit remaining.${suffix}`;
      case 404:
        return (
          `${this.id} has no model called "${this.model}", or the base URL is wrong.` +
          `${suffix}`
        );
      case 400:
        return (
          `${this.id} refused the request as malformed. The usual causes are a model ` +
          `name that endpoint does not have, or a model that cannot return structured ` +
          `output - which this platform requires, because a plan is a structured value.` +
          `${suffix}`
        );
      default:
        return `${this.id} rejected the request${status ? ` (HTTP ${status})` : ''}.${suffix}`;
    }
  }
}

/** The HTTP status an SDK error carries, when it carries one. */
function readStatusCode(error: unknown): number | undefined {
  const candidate = (error as { statusCode?: unknown })?.statusCode;
  return typeof candidate === 'number' ? candidate : undefined;
}

/**
 * The provider's own error message, from the JSON body these APIs return.
 *
 * Bounded and single-line. OpenAI-compatible providers answer with
 * `{"error": {"message": "Model Not Exist"}}`, which names the problem and
 * nothing about the request that caused it.
 */
function readProviderMessage(error: unknown): string | null {
  const body = (error as { responseBody?: unknown })?.responseBody;
  if (typeof body !== 'string' || body.length === 0) return null;

  let text: string | null = null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const candidate = parsed.error?.message ?? parsed.message;
    if (typeof candidate === 'string') text = candidate;
  } catch {
    // Not JSON. An HTML error page or a proxy's plain text says more about the
    // network than the provider, and is not worth quoting.
    return null;
  }

  if (!text) return null;

  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 200 ? `${single.slice(0, 200)}...` : single;
}

/**
 * The model used when a configuration names a provider but no model.
 *
 * Anthropic has one, because "anthropic" identifies a company whose current model
 * can be named. `openai-compatible` does not, because it identifies a *wire
 * format*, not a vendor: the endpoint may be OpenAI, DeepSeek, Groq, OpenRouter
 * or a model somebody is hosting themselves, and they share no model names.
 *
 * This previously returned `gpt-4o-mini` for all of them, which meant a DeepSeek
 * endpoint was asked for a model it has never heard of and answered "Model Not
 * Exist" - a failure that looked like a rejected key. Guessing here was worse
 * than refusing, so it refuses.
 */
function defaultModelFor(provider: ModelProviderSettings['provider']): string | null {
  return provider === 'anthropic' ? 'claude-sonnet-4-5' : null;
}

/**
 * States `stream: false` rather than leaving it to the endpoint's default.
 *
 * The OpenAI specification treats a missing `stream` as false, and the SDK's
 * non-streaming calls omit it. Not every gateway agrees: a local 9router returns
 * Server-Sent Events when the field is absent, which reaches the SDK as "Invalid
 * JSON response" on an HTTP 200 — a failure that reads like a broken model rather
 * than a disagreement about a default.
 *
 * Saying so costs nothing against a gateway that already assumed it. This
 * provider never streams: generateObject for the plan, generateText for the tool
 * loop. If streaming is ever added, this must become conditional.
 */
function withExplicitStream(body: Record<string, unknown>): Record<string, unknown> {
  return 'stream' in body ? body : { ...body, stream: false };
}
