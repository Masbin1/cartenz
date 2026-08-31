import type { BoundaryFinding } from './boundary-types';
import { REDACTIONS } from './boundary-types';
import { applyRules, type ReplacementRule } from './apply-rules';

/**
 * The PII filter (chapter 12, third filter).
 *
 * Redacts rather than refuses, and the reason matters. Source code legitimately
 * contains personal-looking data: an example address in a docstring, a test
 * fixture, a maintainer's email in a manifest. Refusing on any of those would make
 * the platform unusable on real Odoo repositories, which are full of them.
 *
 * What refuses instead is the structural filter, which recognises a *table* of
 * such values - and a table of customer records is what chapter 12 is about.
 *
 * The rules are deliberately narrow. A filter that redacted every number which
 * might be a telephone number would destroy the code it is protecting, so each
 * numeric rule carries a verifier that disqualifies the common false positive.
 */

export interface PiiScanResult {
  readonly content: string;
  readonly findings: readonly BoundaryFinding[];
}

/**
 * Domains whose addresses are not personal information.
 *
 * An Odoo manifest names its author's address, and a module full of
 * `@example.com` fixtures is not a customer list. Redacting these would remove
 * useful context for nothing.
 */
const NON_PERSONAL_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'odoo.com',
  'localhost',
  'test.com',
  'linkederp.com',
]);

function isNonPersonalEmail(match: string): boolean {
  const domain = match.slice(match.lastIndexOf('@') + 1).toLowerCase();
  return NON_PERSONAL_EMAIL_DOMAINS.has(domain) || domain.endsWith('.example');
}

/**
 * Luhn check.
 *
 * Applied to candidate card numbers because a sixteen-digit number is far more
 * often an identifier, a timestamp or a hash prefix than a payment card. Without
 * this the rule would redact ordinary code.
 */
function passesLuhn(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * South African identity number check.
 *
 * Thirteen digits carrying a date in the first six. The date check is what stops
 * the rule matching any thirteen-digit number, which in an Odoo repository would
 * include plenty of ordinary identifiers.
 */
function isPlausibleSaIdNumber(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length !== 13) return false;

  const month = Number.parseInt(digits.slice(2, 4), 10);
  const day = Number.parseInt(digits.slice(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  // The citizenship digit is 0 or 1 in every valid number.
  const citizenship = digits.charCodeAt(10) - 48;
  return citizenship === 0 || citizenship === 1;
}

const RULES: readonly ReplacementRule[] = [
  {
    name: 'email_address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    group: 0,
    // Exempts example and maintainer addresses, which are not personal data.
    verify: (match) => !isNonPersonalEmail(match),
  },
  {
    name: 'payment_card_number',
    pattern: /\b(?:[0-9]{4}[ -]?){3}[0-9]{1,7}\b/g,
    group: 0,
    verify: passesLuhn,
  },
  {
    name: 'sa_id_number',
    pattern: /\b[0-9]{13}\b/g,
    group: 0,
    verify: isPlausibleSaIdNumber,
  },
  {
    // International and South African telephone forms, requiring a separator or a
    // leading + so that a bare run of digits does not match.
    name: 'telephone_number',
    pattern: /(?:\+[0-9]{1,3}[ -]?)?(?:0[0-9]{2}|\([0-9]{3}\))[ -][0-9]{3}[ -][0-9]{4}\b/g,
    group: 0,
  },
];

export function scanForPii(content: string): PiiScanResult {
  const applied = applyRules(content, RULES, REDACTIONS.pii);

  const findings: BoundaryFinding[] = [...applied.counts.entries()].map(([rule, occurrences]) => ({
    kind: 'pii' as const,
    rule,
    occurrences,
  }));

  return { content: applied.content, findings };
}
