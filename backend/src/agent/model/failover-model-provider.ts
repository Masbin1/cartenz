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
