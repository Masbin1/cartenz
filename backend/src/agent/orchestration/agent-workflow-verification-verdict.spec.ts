import { parseVerificationVerdict } from './agent-workflow';

/**
 * ADR-094: task_837942 created three "computed" Monetary fields through
 * odoo_create_field - which has no compute/formula parameter at all, so they
 * were empty static columns - and nothing afterwards checked that they
 * behaved as asked. verifyOdooOnline closes that gap with a second,
 * read-focused model pass whose closing line this function reads for a
 * verdict.
 */
describe('parseVerificationVerdict (ADR-094)', () => {
  it('reads VERIFIED as passed', () => {
    expect(
      parseVerificationVerdict(
        'VERIFIED: created a sample order with cost 1,200,000 and price 2,000,000; ' +
          'x_estimated_gross_profit read back as 800,000, matching the hand calculation.',
      ),
    ).toBe('passed');
  });

  it('reads FAILED as failed', () => {
    expect(
      parseVerificationVerdict(
        'FAILED: x_estimated_profit_margin read back as 0 on every sample order; expected 40%.',
      ),
    ).toBe('failed');
  });

  it('reads NOT VERIFIABLE as skipped', () => {
    expect(
      parseVerificationVerdict(
        'NOT VERIFIABLE: no browser session was open, and the automation rule cannot be ' +
          'checked through the record tools alone.',
      ),
    ).toBe('skipped');
  });

  it('reads a summary with no recognised verdict word as skipped', () => {
    expect(parseVerificationVerdict('I looked at the fields and they seem fine.')).toBe('skipped');
  });

  it('reads an empty summary as skipped', () => {
    expect(parseVerificationVerdict('')).toBe('skipped');
  });

  it('does not misread "not verified" as a pass just because it contains VERIFIED', () => {
    // Guards the fix itself: an early, simpler version of this matched
    // `\bVERIFIED\b` first and would have read this as a pass.
    expect(parseVerificationVerdict('NOT VERIFIED: the margin field does not update.')).toBe(
      'skipped',
    );
  });

  it('is case-sensitive to the uppercase verdict words, by design', () => {
    // The instruction asks the model for the verdict in capitals precisely so
    // casual mentions of the words elsewhere in a summary ("I verified the
    // field exists") do not accidentally produce a verdict.
    expect(parseVerificationVerdict('I verified the field exists and looks correct.')).toBe(
      'skipped',
    );
  });
});
