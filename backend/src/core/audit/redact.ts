/**
 * Redaction for audit records, agent action payloads and realtime events.
 *
 * Chapter 10 of the implementation brief and chapter 11 of the architecture both
 * require that audit records never contain passwords, tokens, API keys, raw
 * secrets or production database records. This module is the enforcement point:
 * every write to audit_logs, agent_actions and agent_task_events passes through
 * `redact`, and there is no other insert path.
 *
 * The approach is deny-by-key rather than detect-by-value. A value-based scanner
 * has to recognise every credential format that exists; a key-based filter only
 * has to recognise the names developers give to sensitive fields, which is a
 * closed and stable set. Both are applied - keys first, then a small set of
 * high-confidence value patterns - but the key filter is the control that is
 * relied upon.
 */

export const REDACTED = '[redacted]';

/**
 * Field names whose values are never recorded. Matched case-insensitively
 * against the key with separators removed, so `api_key`, `apiKey` and `API-KEY`
 * are all caught by the single entry `apikey`.
 */
const DENIED_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'credential',
  'authorization',
  'auth',
  'sessionid',
  'cookie',
  'ssh',
  'pem',
  'certificate',
  'passphrase',
  'salt',
  'hash',
  'signature',
  'dsn',
  'connectionstring',
  'databaseurl',
  'rooturl',
];

/**
 * Keys that contain a denied fragment but are safe and useful to record. Without
 * these, an audit trail loses information that matters: which reference was
 * used, and which authentication method was chosen.
 */
const ALLOWED_KEYS: readonly string[] = [
  'secretref',
  'tokenid',
  'authmethod',
  'authprovider',
  // Both sides go through normaliseKey, so entries here need no particular
  // casing or separators; 'hasCredentials' and 'hascredentials' were the same
  // entry twice.
  'hascredentials',
  // Facts *about* a stored credential, not the credential (ADR-023). Without
  // these the trail cannot answer "was the key changed, and is one set", which
  // is the whole reason the event is recorded.
  'credentialreplaced',
  'credentialstored',
];

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 2048;
const MAX_ARRAY_LENGTH = 100;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDeniedKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (ALLOWED_KEYS.some((allowed) => normaliseKey(allowed) === normalised)) {
    return false;
  }
  return DENIED_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * High-confidence credential shapes, applied to string values regardless of the
 * key they arrived under. Kept short on purpose: a broad pattern that redacts
 * ordinary text makes the audit trail unreadable, which is its own failure.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  // GitHub personal access, OAuth, user-to-server and refresh tokens.
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  // GitLab personal and project access tokens.
  /glpat-[A-Za-z0-9_-]{16,}/g,
  // Anthropic and OpenAI style keys.
  /sk-[A-Za-z0-9_-]{20,}/g,
  // Bearer credentials in a header-like string.
  /(?<=[Bb]earer )[A-Za-z0-9._-]{20,}/g,
  // Credentials embedded in a URL: scheme://user:password@host
  /([a-z][a-z0-9+.-]*:[/][/][^:@/\s]+:)[^@/\s]+(?=@)/g,
  // PEM private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function redactString(value: string): string {
  let result = value;
  for (const pattern of VALUE_PATTERNS) {
    result = result.replace(pattern, (_match, prefix) =>
      typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED,
    );
  }
  if (result.length > MAX_STRING_LENGTH) {
    result = `${result.slice(0, MAX_STRING_LENGTH)}... [truncated]`;
  }
  return result;
}

/**
 * Recursively redacts a value for persistence. Depth, string length and array
 * length are bounded so that a large or cyclic payload cannot be used to bloat
 * the audit table.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (depth >= MAX_DEPTH) return '[depth limit]';

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Buffer.isBuffer(value)) return `[binary ${value.byteLength} bytes]`;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push(`[${value.length - MAX_ARRAY_LENGTH} more items omitted]`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isDeniedKey(key)) {
        output[key] = REDACTED;
        continue;
      }
      const redacted = redact(entry, depth + 1);
      if (redacted !== undefined) output[key] = redacted;
    }
    return output;
  }

  return undefined;
}

/**
 * Redacts a metadata object for a table column typed as an object. Anything that
 * does not redact to a plain object is discarded rather than coerced, so a
 * malformed payload cannot corrupt the column.
 */
export function redactMetadata(value: unknown): Record<string, unknown> {
  const redacted = redact(value);
  if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return {};
  }
  return redacted as Record<string, unknown>;
}
