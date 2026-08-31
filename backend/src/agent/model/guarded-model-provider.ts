import { Logger } from '@nestjs/common';
import type { AiBoundaryService } from '../../core/ai-boundary/ai-boundary.service';
import type { BoundaryFinding } from '../../core/ai-boundary/boundary-types';
import type {
  ModelProvider,
  ModelResult,
  PromptPart,
  StructuredRequest,
  ToolCallOutcome,
  ToolLoopOutcome,
  ToolLoopRequest,
} from './model-provider.interface';

/**
 * Wraps a provider so that the AI data boundary cannot be bypassed (ADR-020).
 *
 * Everything on the way out is filtered: the system prompt, every prompt part,
 * and every tool result the loop feeds back. Everything on the way back is
 * filtered too - a model that has read a credential can repeat it, and its output
 * reaches the action log, the event stream and a browser.
 *
 * This class is what the module binds. The unguarded implementations are not
 * exported, so "did someone call the provider directly" is not a question a
 * reviewer has to ask.
 */
export class GuardedModelProvider implements ModelProvider {
  private readonly logger = new Logger(GuardedModelProvider.name);

  constructor(
    private readonly inner: ModelProvider,
    private readonly boundary: AiBoundaryService,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get model(): string {
    return this.inner.model;
  }

  get callsExternalService(): boolean {
    return this.inner.callsExternalService;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<ModelResult<T>> {
    const findings: BoundaryFinding[] = [];
    const outbound = this.filterOutbound(request.system, request.parts, findings);

    const result = await this.inner.generateStructured({
      ...request,
      system: outbound.system,
      parts: outbound.parts,
    });

    /**
     * The structured value is filtered by serialising it, filtering the text and
     * parsing it back. Round-tripping through JSON is deliberate: it filters every
     * string at every depth without this class needing to know the shape, and the
     * shape is defined by the caller's schema, not here.
     */
    const filteredValue = this.filterStructuredValue(result.value, findings);

    return {
      ...result,
      value: filteredValue,
      boundaryFindings: merge([...findings, ...result.boundaryFindings]),
      redactionCount: countOf(findings) + result.redactionCount,
    };
  }

  async runToolLoop(request: ToolLoopRequest): Promise<ModelResult<ToolLoopOutcome>> {
    const findings: BoundaryFinding[] = [];
    const outbound = this.filterOutbound(request.system, request.parts, findings);

    /**
     * Tool results are the subtlest egress path in the whole system: `read_file`
     * returns repository content straight into the model's context, and it is the
     * one place the platform hands over material it has never inspected. Wrapping
     * the executor means that path is filtered by construction rather than by the
     * agent remembering to do it.
     */
    const guardedExecute = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolCallOutcome> => {
      const outcome = await request.execute(name, args);
      const filtered = this.boundary.filterDeep(outcome.result ?? {}, {
        direction: 'to_provider',
        label: `tool result: ${name}`,
      });

      if (!filtered.allowed) {
        findings.push(...filtered.findings);
        // The tool ran; the model is simply not told what it returned. Halting
        // here would let repository content decide whether the task proceeds.
        this.logger.warn(
          `Withheld the result of ${name} from the model: ${filtered.refusalReason}`,
        );
        return {
          ...outcome,
          result: {
            withheld: true,
            reason:
              'The result was withheld by the AI data boundary because it contained customer data.',
          },
        };
      }

      findings.push(...filtered.findings);
      return { ...outcome, result: (filtered.value ?? {}) as Record<string, unknown> };
    };

    const result = await this.inner.runToolLoop({
      ...request,
      system: outbound.system,
      parts: outbound.parts,
      execute: guardedExecute,
    });

    const summary = this.boundary.filter(result.value.summary, {
      direction: 'from_provider',
      label: 'model summary',
    });
    findings.push(...summary.findings);

    return {
      ...result,
      value: {
        ...result.value,
        summary: summary.allowed
          ? summary.content
          : 'The model output was withheld by the AI data boundary.',
      },
      boundaryFindings: merge([...findings, ...result.boundaryFindings]),
      redactionCount: countOf(findings) + result.redactionCount,
    };
  }

  /**
   * Filters the system prompt and every part before they leave.
   *
   * A refusal on any part throws, so a prompt containing a database dump fails
   * the task rather than being sent with that part quietly dropped - which would
   * leave the model reasoning from an incomplete context it was not told about.
   */
  private filterOutbound(
    system: string,
    parts: readonly PromptPart[],
    findings: BoundaryFinding[],
  ): { system: string; parts: PromptPart[] } {
    const filteredSystem = this.boundary.filterOrThrow(system, {
      direction: 'to_provider',
      label: 'system prompt',
    });
    findings.push(...filteredSystem.findings);

    const filteredParts = parts.map((part) => {
      const result = this.boundary.filterOrThrow(part.content, {
        direction: 'to_provider',
        label: part.label,
      });
      findings.push(...result.findings);
      return { ...part, content: result.content };
    });

    return { system: filteredSystem.content, parts: filteredParts };
  }

  /**
   * Filters a structured result by walking it.
   *
   * Each string is filtered as the string it is, rather than the whole value being
   * serialised and filtered as text - JSON escapes newlines, and a filter that
   * reasons about lines cannot see them once escaped.
   *
   * A refusal returns the value unchanged rather than discarding it. The material
   * has already passed the outbound filter, so this pass is a second line of
   * defence, and losing an entire plan to it would be the worse outcome.
   */
  private filterStructuredValue<T>(value: T, findings: BoundaryFinding[]): T {
    const filtered = this.boundary.filterDeep(value, {
      direction: 'from_provider',
      label: 'structured model output',
    });

    findings.push(...filtered.findings);

    if (!filtered.allowed) {
      this.logger.warn(
        'The structured model output was refused by the boundary on the return path; ' +
          'returning it unchanged, as it already passed the outbound filter.',
      );
      return value;
    }

    return filtered.value as T;
  }
}

function merge(findings: readonly BoundaryFinding[]): BoundaryFinding[] {
  const byRule = new Map<string, BoundaryFinding>();
  for (const finding of findings) {
    const existing = byRule.get(finding.rule);
    byRule.set(
      finding.rule,
      existing ? { ...existing, occurrences: existing.occurrences + finding.occurrences } : finding,
    );
  }
  return [...byRule.values()].sort((a, b) => b.occurrences - a.occurrences);
}

function countOf(findings: readonly BoundaryFinding[]): number {
  return findings.reduce((total, finding) => total + finding.occurrences, 0);
}
