import { applyRules, type ReplacementRule } from './apply-rules';

/**
 * Overlap resolution decides which of two matching rules wins, and the answer is
 * not cosmetic: it determines whether the redacted file is still syntactically
 * valid, and which rule name reaches the audit trail.
 */
describe('applyRules', () => {
  const specific: ReplacementRule = {
    name: 'github_token',
    pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g,
    group: 0,
  };

  const general: ReplacementRule = {
    name: 'assigned_secret',
    pattern: /((?:api_?key|token|password)\s*[:=]\s*)(['"][^'"\n]{4,}['"])/gi,
    group: 2,
  };

  it('counts a value matching two rules once, not twice', () => {
    const result = applyRules(
      'API_KEY = "ghp_abcdefghijklmnopqrstuvwxyz"',
      [specific, general],
      '[redacted]',
    );

    expect(result.totalReplacements).toBe(1);
  });

  it('gives an overlap to the earlier-declared rule', () => {
    const result = applyRules(
      'API_KEY = "ghp_abcdefghijklmnopqrstuvwxyz"',
      [specific, general],
      '[redacted]',
    );

    expect([...result.counts.keys()]).toEqual(['github_token']);
  });

  /**
   * The reason the precedence matters. The specific rule replaces the token and
   * leaves the quotes; the general rule replaces the quoted value entirely and
   * leaves invalid Python for the model to read.
   */
  it('leaves the redacted assignment syntactically valid', () => {
    const result = applyRules(
      'API_KEY = "ghp_abcdefghijklmnopqrstuvwxyz"',
      [specific, general],
      '[redacted]',
    );

    expect(result.content).toBe('API_KEY = "[redacted]"');
  });

  it('applies the general rule where no specific rule matches', () => {
    const result = applyRules(
      'password = "correct horse battery"',
      [specific, general],
      '[redacted]',
    );

    expect([...result.counts.keys()]).toEqual(['assigned_secret']);
    expect(result.content).toBe('password = [redacted]');
  });

  it('replaces every occurrence, and keeps offsets correct across them', () => {
    const result = applyRules(
      'a = "ghp_aaaaaaaaaaaaaaaaaa" and b = "ghp_bbbbbbbbbbbbbbbbbb"',
      [specific],
      '[redacted]',
    );

    expect(result.totalReplacements).toBe(2);
    expect(result.content).toBe('a = "[redacted]" and b = "[redacted]"');
  });

  it('honours a verifier that rejects a match', () => {
    const result = applyRules(
      'ghp_aaaaaaaaaaaaaaaaaa',
      [{ ...specific, verify: () => false }],
      '[redacted]',
    );

    expect(result.totalReplacements).toBe(0);
    expect(result.content).toBe('ghp_aaaaaaaaaaaaaaaaaa');
  });

  it('does not depend on how many times it has been called', () => {
    // The declared patterns are global and carry lastIndex, so a shared RegExp
    // would make the result depend on call history.
    const material = 'API_KEY = "ghp_abcdefghijklmnopqrstuvwxyz"';
    const first = applyRules(material, [specific, general], '[redacted]');
    const second = applyRules(material, [specific, general], '[redacted]');

    expect(second.content).toBe(first.content);
    expect(second.totalReplacements).toBe(first.totalReplacements);
  });

  it('terminates on a pattern that can match empty', () => {
    const result = applyRules('abc', [{ name: 'empty', pattern: /x*/g, group: 0 }], '[r]');
    expect(typeof result.content).toBe('string');
  });
});
