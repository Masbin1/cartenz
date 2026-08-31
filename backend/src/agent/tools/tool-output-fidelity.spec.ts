import { redactMetadata } from '../../core/audit/redact';

/**
 * Tool output fidelity (ADR-022).
 *
 * The execution service keeps two copies of a tool's output: the real one, which
 * the agent acts on, and a redacted one, which is persisted and published.
 * Conflating them was a real defect - redactMetadata truncates every string to
 * 2 KB, so read_file silently returned the first ~55 lines of any larger file and
 * a write-back destroyed the remainder.
 *
 * These tests pin the two properties that must both hold, because the defect came
 * from holding only one of them. They deliberately assert against the real
 * redaction filter rather than a stub: the truncation is the filter's behaviour,
 * and a stub would let the filter change without this failing.
 */
describe('the audit redaction filter', () => {
  const bigFile = Array.from({ length: 1101 }, (_, i) => `    line_${i} = fields.Char()`).join('\n');

  it('truncates a long string, which is why it must not be what the agent reads', () => {
    const redacted = redactMetadata({ content: bigFile }) as { content: string };

    expect(bigFile.length).toBeGreaterThan(2048);
    expect(redacted.content.length).toBeLessThan(bigFile.length);
    expect(redacted.content).toContain('[truncated]');
  });

  it('loses almost all of a real-sized Odoo module', () => {
    // The concrete shape of the defect: what a 1101-line file became.
    const redacted = redactMetadata({ content: bigFile }) as { content: string };
    const keptLines = redacted.content.split('\n').length;

    expect(bigFile.split('\n').length).toBe(1101);
    expect(keptLines).toBeLessThan(100);
  });

  it('is still what should be persisted, because it removes credentials', () => {
    const redacted = redactMetadata({
      content: 'COURIER_API_KEY = "ghp_realtokenabcdefghijklmnopqrstuvwx"',
    }) as { content: string };

    expect(redacted.content).not.toContain('ghp_realtokenabcdefghijklmnopqrstuvwx');
  });
});
