import type { BoundaryFinding } from './boundary-types';
import { REDACTIONS } from './boundary-types';
import { applyRules, type ReplacementRule } from './apply-rules';

/**
 * The secret scanner (chapter 12, first filter).
 *
 * Distinct from `core/audit/redact.ts`, and deliberately so. That module protects
 * the audit trail, where the key names are ours and a deny-by-key filter is the
 * right control. This one scans *source code*, where the key names belong to the
 * customer and a key-based filter has nothing to work with. So the rules here are
 * value-shaped: what a credential looks like, not what someone called it.
 *
 * The rules are high-confidence on purpose. A scanner that redacts anything
 * resembling a long random string would strip hashes, UUIDs and minified assets
 * out of every file, leaving the model less context and no more safety. Each rule
 * below matches a format that is a credential and is not something else.
 */

/**
 * The rules, in priority order.
 *
 * Order is load-bearing: the specific format rules come first so that a value
 * matching both a format rule and the general assigned-secret rule is attributed
 * to the format rule and counted once (see apply-rules).
 */
const RULES: readonly ReplacementRule[] = [
  // Provider keys. Prefixes are vendor-assigned and unambiguous.
  { name: 'anthropic_api_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { name: 'openai_api_key', pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, group: 0 },
  // Git hosting tokens.
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g, group: 0 },
  { name: 'github_fine_grained_token', pattern: /github_pat_[A-Za-z0-9_]{20,}/g, group: 0 },
  { name: 'gitlab_token', pattern: /glpat-[A-Za-z0-9_-]{16,}/g, group: 0 },
  // Cloud provider credentials.
  { name: 'aws_access_key_id', pattern: /A(?:KIA|SIA|ROA|IDA)[0-9A-Z]{16}/g, group: 0 },
  { name: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}/g, group: 0 },
  { name: 'slack_token', pattern: /xox[abprs]-[0-9A-Za-z-]{10,}/g, group: 0 },
  { name: 'stripe_key', pattern: /(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/g, group: 0 },
  // A private key block, however long.
  {
    name: 'private_key_block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    group: 0,
  },
  // A credential embedded in a URL. Only the secret is replaced, so the host
  // stays readable and the model can still reason about the connection.
  {
    name: 'credential_in_url',
    pattern: /([a-z][a-z0-9+.-]*:[/][/][^:@/\s]+:)([^@/\s]{3,})(?=@)/gi,
    group: 2,
  },
  /**
   * An assignment to a variable whose name denotes a secret.
   *
   * This is the rule that catches an Odoo `odoo.conf` `admin_passwd`, a
   * `db_password` in a settings module, and the general case of a credential
   * that has no recognisable format of its own. Restricted to a quoted value on
   * the same line, so it does not swallow a block of code.
   */
  {
    name: 'assigned_secret',
    pattern:
      /((?:password|passwd|secret|token|api_?key|access_?key|private_?key|passphrase|credential)\s*[:=]\s*)(['"][^'"\n]{4,}['"])/gi,
    group: 2,
  },
];

export interface SecretScanResult {
  readonly content: string;
  readonly findings: readonly BoundaryFinding[];
  /**
   * True when the material looks like a credential file rather than source that
   * happens to mention one. Such material is refused, not redacted.
   */
  readonly looksLikeCredentialStore: boolean;
}

/**
 * Above this many findings in a single payload, the material is treated as a
 * credential store rather than as source code.
 *
 * The reasoning: a source file might legitimately contain one or two example
 * keys in a docstring. A file containing a dozen is a `.env`, a keyring export or
 * a secrets manifest, and redacting it would send its structure and variable
 * names to a provider while claiming the content was protected. Refusing is the
 * honest outcome.
 */
const CREDENTIAL_STORE_THRESHOLD = 8;

/**
 * Scans and redacts.
 *
 * Every rule is evaluated against the original text and overlaps are resolved
 * once, so a value matching two rules is redacted once and counted once.
 */
export function scanForSecrets(content: string): SecretScanResult {
  const applied = applyRules(content, RULES, REDACTIONS.secret);

  const findings: BoundaryFinding[] = [...applied.counts.entries()].map(([rule, occurrences]) => ({
    kind: 'secret' as const,
    rule,
    occurrences,
  }));

  return {
    content: applied.content,
    findings,
    looksLikeCredentialStore: applied.totalReplacements >= CREDENTIAL_STORE_THRESHOLD,
  };
}
