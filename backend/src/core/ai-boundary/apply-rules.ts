/**
 * Single-pass rule application with overlap resolution.
 *
 * Written because the obvious approach is wrong. Applying each rule to the output
 * of the last means a value can be matched twice: `token = "ghp_..."` matches the
 * GitHub-token rule by its format and the assigned-secret rule by its variable
 * name, so it was redacted twice and counted twice. The count is shown to users
 * and recorded in the audit trail, so an inflated one is not cosmetic.
 *
 * Instead every rule is evaluated against the original text, the matches are
 * collected with their positions, overlaps are resolved in favour of the
 * earlier-declared rule, and the replacements are applied once. Nothing is
 * matched against a replacement, and the counts are exact.
 */

export interface ReplacementRule {
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * Which capture group holds the sensitive part. 0 replaces the whole match; a
   * positive value preserves the text before it, which matters where the
   * surrounding context is useful and only the value is sensitive.
   */
  readonly group: number;
  /** Rejects a match the pattern alone cannot disqualify, such as a Luhn check. */
  readonly verify?: (match: string) => boolean;
}

interface Candidate {
  readonly rule: string;
  /** Where the replacement begins: the group's offset, not the match's. */
  readonly start: number;
  readonly end: number;
  /** Declaration order, used to resolve an overlap deterministically. */
  readonly priority: number;
}

export interface RuleApplicationResult {
  readonly content: string;
  readonly counts: ReadonlyMap<string, number>;
  readonly totalReplacements: number;
}

export function applyRules(
  content: string,
  rules: readonly ReplacementRule[],
  replacement: string,
): RuleApplicationResult {
  const candidates: Candidate[] = [];

  for (const [priority, rule] of rules.entries()) {
    // A fresh RegExp per call: the declared patterns are global and carry
    // lastIndex, which would make the result depend on call history.
    const pattern = new RegExp(rule.pattern.source, ensureGlobal(rule.pattern.flags));

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      // A zero-length match would loop forever.
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }

      if (rule.verify && !rule.verify(match[0])) continue;

      const span = spanOf(match, rule.group);
      if (span) candidates.push({ rule: rule.name, ...span, priority });
    }
  }

  const resolved = resolveOverlaps(candidates);
  const counts = new Map<string, number>();
  for (const candidate of resolved) {
    counts.set(candidate.rule, (counts.get(candidate.rule) ?? 0) + 1);
  }

  // Applied from the end so earlier offsets stay valid.
  let output = content;
  for (const candidate of [...resolved].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, candidate.start) + replacement + output.slice(candidate.end);
  }

  return { content: output, counts, totalReplacements: resolved.length };
}

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

/**
 * The span to replace.
 *
 * For group 0 it is the whole match. For a positive group it is that group's own
 * position, found by locating the group's text within the match - `exec` does not
 * report group offsets without the `d` flag, and requiring that flag on every
 * pattern would be one more thing to get wrong.
 */
function spanOf(
  match: RegExpExecArray,
  group: number,
): { start: number; end: number } | null {
  const matchStart = match.index;

  if (group === 0) {
    return { start: matchStart, end: matchStart + match[0].length };
  }

  const groupText = match[group];
  if (typeof groupText !== 'string' || groupText.length === 0) return null;

  // Searched from the end of the match backwards, so that a group whose text also
  // appears earlier in the match resolves to the right occurrence.
  const offset = match[0].lastIndexOf(groupText);
  if (offset === -1) return null;

  return { start: matchStart + offset, end: matchStart + offset + groupText.length };
}

/**
 * Discards a candidate overlapping one already kept.
 *
 * Sorted by declaration order first, position second - and that order matters more
 * than it looks. `COURIER_API_KEY = "ghp_..."` matches two rules: the GitHub-token
 * rule on the token itself, and the general assigned-secret rule on the whole
 * quoted value, which begins one character earlier at the opening quote.
 *
 * Sorting by position would hand it to the general rule, which strips the quotes
 * along with the value and leaves `KEY = [redacted]` - not valid Python. The model
 * then reads a syntactically broken file. Sorting by declaration order hands it to
 * the specific rule, which replaces only the token and leaves `KEY = "[redacted]"`,
 * and the specific rule is also the more informative one to record.
 *
 * So the rule sets declare their specific rules first, and this honours that.
 */
function resolveOverlaps(candidates: readonly Candidate[]): Candidate[] {
  const sorted = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.start - b.start || b.end - a.end,
  );

  // Kept spans are no longer in positional order, so an overlap has to be checked
  // against all of them rather than against the last one alone.
  const kept: Candidate[] = [];

  for (const candidate of sorted) {
    const overlaps = kept.some(
      (existing) => candidate.start < existing.end && existing.start < candidate.end,
    );
    if (!overlaps) kept.push(candidate);
  }

  return kept;
}
