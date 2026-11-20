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
     * Repeated-call guard (task_230820: a chat task calling `search_code` with
     * the exact same query fifteen times in a row - 26 reads in all - until the
     * step budget ran out with no answer given). Nothing upstream of this
     * wrapper compares a call to what came before it: the step and tool-call
     * budgets are just counters, so a model stuck repeating itself burns the
     * whole budget before either one objects, and the task fails having done
     * nothing.
     *
     * Scoped to this one loop invocation (one task attempt), not persisted
     * beyond it - a resumed task counts fresh, which is deliberate: its
     * `priorProgress` already tells the model what happened last time, and a
     * Map surviving across HTTP calls would need a store, for a problem that is
     * about one run getting stuck, not about memory across runs.
     */
    const callCounts = new Map<string, number>();

    /**
     * Zero-result search_code streak guard (task_878534: a chat task trying
     * eleven different search_code queries chasing the same symbol -
     * "int_type_id", "int_type_id =", "'int_type_id'", "int_type_id =
     * fields.Many2one(...)" and so on - seven of them returning zero matches,
     * before the step budget ran out with no answer. The repeated-call guard
     * above does not catch this: every query string was different, so none of
     * them looked like a repeat.
     *
     * What actually repeats is the *outcome*, not the input: a model guessing
     * variations of how a symbol might be spelled in the source, when it is
     * not there to find. Tracked as a streak reset by any successful (non-zero)
     * search, not by other tool calls in between - reading a file does not fix
     * the search, so it should not reset the count either.
     */
    let zeroResultSearchStreak = 0;

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
      const signature = `${name}::${stableStringify(args ?? {})}`;
      const priorCount = callCounts.get(signature) ?? 0;
      callCounts.set(signature, priorCount + 1);

      // The 3rd and every later identical call is refused outright - the real
      // tool never runs, so a loop like task_230820's costs no further real
      // work once spotted, and the model is told plainly rather than left to
      // find out by getting the same result back again.
      if (priorCount >= 2) {
        this.logger.warn(
          `Refused a repeated identical call to ${name} (attempt ${priorCount + 1}, ` +
            `same arguments as before): ${signature}`,
        );
        return {
          result: {
            status: 'denied',
            message:
              `You already called ${name} with these exact same arguments ${priorCount} ` +
              'time(s) before in this task, and the result will not change by calling it ' +
              'again. Repeating it will keep being refused. Use what the earlier result ' +
              'already told you and answer now, or do something genuinely different instead.',
          },
        };
      }

      // The 5th search_code in a row that found nothing is refused outright:
      // four failed guesses at how a symbol might be spelled is enough to show
      // it genuinely is not there, and a 5th guess is the same dead end with
      // different punctuation.
      if (name === 'search_code' && zeroResultSearchStreak >= 4) {
        this.logger.warn(
          `Refused search_code after ${zeroResultSearchStreak} consecutive zero-result ` +
            `searches: ${signature}`,
        );
        return {
          result: {
            status: 'denied',
            message:
              `The last ${zeroResultSearchStreak} search_code calls in a row found nothing, ` +
              'including this query. Guessing another spelling or phrasing of the same symbol ' +
              'will not find it either - it is genuinely not present as literal text in this ' +
              'repository. Stop searching for it and answer with what you have found so far, ' +
              'stating plainly that this symbol could not be located.',
          },
        };
      }

      const outcome = await request.execute(name, args);

      if (name === 'search_code') {
        const matchCount = (outcome.result as { matchCount?: unknown } | undefined)?.matchCount;
        zeroResultSearchStreak = matchCount === 0 ? zeroResultSearchStreak + 1 : 0;
      }

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
      const value = (filtered.value ?? {}) as Record<string, unknown>;

      // The 2nd identical call still runs - a deliberate second look is
      // legitimate (orient, then confirm before finishing) - but it is told
      // plainly that nothing changed, so a 3rd attempt is a choice the model
      // makes with the fact in front of it, not a surprise refusal.
      if (priorCount === 1) {
        return {
          ...outcome,
          result: {
            ...value,
            _repeat_notice:
              `This is the same call to ${name} with the same arguments you already made ` +
              'once before. The result is unchanged. Calling it again will be refused.',
          },
        };
      }

      // A warning on the 3rd consecutive zero-result search_code, one guess
      // before the hard refusal above - so the model sees the pattern named
      // while it still has one more free attempt, rather than being refused
      // with no warning in between.
      if (name === 'search_code' && zeroResultSearchStreak === 3) {
        return {
          ...outcome,
          result: {
            ...value,
            _repeat_notice:
              'The last 3 search_code calls in a row, including this one, found nothing. ' +
              'One more zero-result search_code will be refused - stop guessing variations ' +
              'of this symbol and answer with what you have, or search for something different.',
          },
        };
      }

      return { ...outcome, result: value };
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

/**
 * Deterministic JSON, independent of key insertion order.
 *
 * Model tool calls are parsed from the model's own JSON output, which does not
 * promise a stable key order across two calls that mean the same thing (e.g.
 * `{path, query}` vs `{query, path}`). `JSON.stringify` alone would treat those
 * as different signatures and let the repeated-call guard above miss them.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
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
