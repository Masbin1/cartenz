import { Injectable, Logger } from '@nestjs/common';
import {
  AiBoundaryRefusalError,
  type BoundaryFinding,
  type BoundaryOptions,
  type BoundaryResult,
} from './boundary-types';
import { inspectForSensitiveData } from './sensitive-data-filter';
import { scanForSecrets } from './secret-scanner';
import { scanForPii } from './pii-filter';

/**
 * The AI data boundary (chapter 12, ADR-020).
 *
 * Every byte that reaches a model provider, and every byte that comes back,
 * passes through `filter`. Nothing else in the codebase calls a provider: the
 * unguarded provider implementations are not exported from their module, so this
 * is a chokepoint by construction rather than by convention.
 *
 * The order is the one chapter 12 states, and it is not arbitrary:
 *
 *  1. **Structural inspection first.** If the material is a database dump there
 *     is no point redacting values out of it - it is refused whole. Doing this
 *     first also means the more expensive per-value passes are skipped.
 *  2. **Secrets second.** A credential is the highest-consequence leak, and
 *     removing it before the PII pass means a token that happens to look like an
 *     identity number is already gone.
 *  3. **PII last**, over material that is by then free of secrets.
 */
@Injectable()
export class AiBoundaryService {
  private readonly logger = new Logger(AiBoundaryService.name);

  filter(content: string, options: BoundaryOptions): BoundaryResult {
    const original = content ?? '';
    const findings: BoundaryFinding[] = [];

    // 1. Structural. Refuses rather than redacts.
    const structural = inspectForSensitiveData(original);
    findings.push(...structural.findings);

    if (structural.refusalReason) {
      this.logger.warn(
        `Boundary refused "${options.label}" (${options.direction}): ${structural.refusalReason}`,
      );
      return {
        content: '',
        allowed: false,
        refusalReason: structural.refusalReason,
        findings,
        redactionCount: 0,
        bytesRemoved: original.length,
      };
    }

    // 2. Secrets.
    const secrets = scanForSecrets(original);
    findings.push(...secrets.findings);

    if (secrets.looksLikeCredentialStore) {
      const reason =
        'the density of credentials suggests a secrets file rather than source code; ' +
        'redacting it would still send its structure and variable names';
      this.logger.warn(`Boundary refused "${options.label}" (${options.direction}): ${reason}`);
      return {
        content: '',
        allowed: false,
        refusalReason: reason,
        findings,
        redactionCount: 0,
        bytesRemoved: original.length,
      };
    }

    // 3. Personal information.
    const pii = scanForPii(secrets.content);
    findings.push(...pii.findings);

    const redactionCount = findings.reduce((total, finding) => total + finding.occurrences, 0);
    const bytesRemoved = Math.max(0, original.length - pii.content.length);

    if (redactionCount > 0) {
      this.logger.log(
        `Boundary redacted ${redactionCount} item(s) from "${options.label}" (${options.direction}): ` +
          findings.map((finding) => `${finding.rule} x${finding.occurrences}`).join(', '),
      );
    }

    return {
      content: pii.content,
      allowed: true,
      findings,
      redactionCount,
      bytesRemoved,
    };
  }

  /**
   * Filters, or throws.
   *
   * A refusal is thrown rather than returned so that a caller which ignores the
   * result cannot proceed with unfiltered material. `filter` remains available
   * where a caller genuinely needs to inspect the outcome.
   */
  filterOrThrow(content: string, options: BoundaryOptions): BoundaryResult {
    const result = this.filter(content, options);
    if (!result.allowed) {
      throw new AiBoundaryRefusalError(
        options.label,
        result.refusalReason ?? 'the material was refused',
        result.findings,
      );
    }
    return result;
  }

  /**
   * Filters every string inside a structure, in place.
   *
   * Necessary because serialising first and filtering the text does not work: JSON
   * escapes newlines, so a multi-line CSV or a pg_dump becomes one long line and
   * the structural filter - which reasons about rows and headers - cannot see it.
   * A tool result containing a database export would have passed.
   *
   * So each string is filtered as the string it is. A refusal anywhere makes the
   * whole structure refused, because a record set is not made safe by keeping the
   * fields around it.
   */
  filterDeep(
    value: unknown,
    options: BoundaryOptions,
  ): {
    readonly value: unknown;
    readonly allowed: boolean;
    readonly refusalReason?: string;
    readonly findings: readonly BoundaryFinding[];
    readonly redactionCount: number;
  } {
    const findings: BoundaryFinding[] = [];
    let refusalReason: string | undefined;
    let redactionCount = 0;

    const walk = (input: unknown, depth: number): unknown => {
      if (refusalReason !== undefined) return input;
      // Bounded like the audit redactor, so a deep or cyclic structure cannot
      // make this run away.
      if (depth > 8) return '[depth limit]';

      if (typeof input === 'string') {
        const result = this.filter(input, options);
        findings.push(...result.findings);

        if (!result.allowed) {
          refusalReason = result.refusalReason;
          return '';
        }

        redactionCount += result.redactionCount;
        return result.content;
      }

      if (Array.isArray(input)) {
        return input.slice(0, 200).map((item) => walk(item, depth + 1));
      }

      if (input !== null && typeof input === 'object') {
        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
          output[key] = walk(entry, depth + 1);
        }
        return output;
      }

      return input;
    };

    const filtered = walk(value, 0);

    if (refusalReason !== undefined) {
      return { value: undefined, allowed: false, refusalReason, findings, redactionCount: 0 };
    }

    return { value: filtered, allowed: true, findings, redactionCount };
  }

  /**
   * Filters several parts and returns them with combined findings.
   *
   * Used for a prompt assembled from many files: each part is filtered
   * separately, so a refusal names the part responsible rather than failing the
   * whole prompt anonymously.
   */
  filterParts(
    parts: readonly { readonly label: string; readonly content: string }[],
    direction: BoundaryOptions['direction'],
  ): { readonly parts: readonly { label: string; content: string }[]; readonly summary: BoundaryResult } {
    const filtered: { label: string; content: string }[] = [];
    const findings: BoundaryFinding[] = [];
    let redactionCount = 0;
    let bytesRemoved = 0;

    for (const part of parts) {
      const result = this.filterOrThrow(part.content, { direction, label: part.label });
      filtered.push({ label: part.label, content: result.content });
      findings.push(...result.findings);
      redactionCount += result.redactionCount;
      bytesRemoved += result.bytesRemoved;
    }

    return {
      parts: filtered,
      summary: {
        content: '',
        allowed: true,
        findings: mergeFindings(findings),
        redactionCount,
        bytesRemoved,
      },
    };
  }
}

/** Combines findings of the same rule, so a summary is readable. */
function mergeFindings(findings: readonly BoundaryFinding[]): BoundaryFinding[] {
  const byRule = new Map<string, BoundaryFinding>();

  for (const finding of findings) {
    const existing = byRule.get(finding.rule);
    byRule.set(
      finding.rule,
      existing
        ? { ...existing, occurrences: existing.occurrences + finding.occurrences }
        : finding,
    );
  }

  return [...byRule.values()].sort((a, b) => b.occurrences - a.occurrences);
}
