import { BACKSLASH } from '../../core/path-utils';

/**
 * Odoo manifest parsing (ADR-019).
 *
 * An `__manifest__.py` is a Python file containing a dictionary literal. The
 * obvious way to read one is to execute it. That is exactly what this module must
 * not do: a manifest is untrusted content from a customer repository, and
 * executing it would be Risk A of ADR-019 - the thing the isolation boundary
 * exists for - in the analysis step, before any user has approved anything.
 *
 * So the values the platform needs are extracted from the text instead. The
 * parser is deliberately narrow rather than a Python literal evaluator: it reads
 * the keys the platform uses, accepts the two quoting styles Odoo modules actually
 * use, and reports the rest as unread. A manifest it cannot parse yields a module
 * with a missing field, which is a visibly incomplete answer rather than a wrong
 * one.
 *
 * Every pattern below is a regular-expression literal rather than a string passed
 * to `new RegExp`. That is deliberate: a pattern assembled from strings needs its
 * backslashes doubled, and a missed one produces an expression that compiles and
 * matches the wrong thing.
 */

export interface OdooManifest {
  /** Directory name of the module - its technical name. */
  readonly technicalName: string;
  readonly name: string | null;
  readonly version: string | null;
  readonly depends: readonly string[];
  readonly category: string | null;
  readonly license: string | null;
  readonly installable: boolean | null;
  readonly applicationFlag: boolean | null;
  /** Keys present in the file that this parser does not read. */
  readonly unparsedKeys: readonly string[];
}

const MAX_MANIFEST_BYTES = 64 * 1024;

/** Keys this parser reads. Anything else present is reported as unread. */
const READ_KEYS = new Set([
  'name',
  'version',
  'depends',
  'category',
  'license',
  'installable',
  'application',
]);

/**
 * Strips Python comments and docstrings so that a `#` inside a comment cannot be
 * mistaken for content, and a commented-out key is not read as live.
 *
 * Quote state is tracked character by character rather than with a regular
 * expression, because a `#` inside a string is not a comment and a regular
 * expression cannot tell the difference.
 */
function stripCommentsAndDocstrings(source: string): string {
  let output = '';
  let index = 0;
  let quote: string | null = null;
  let tripleQuote: string | null = null;

  while (index < source.length) {
    const char = source[index];
    const next3 = source.slice(index, index + 3);

    if (tripleQuote) {
      if (next3 === tripleQuote) {
        tripleQuote = null;
        index += 3;
        continue;
      }
      index += 1;
      continue;
    }

    if (quote) {
      output += char;
      if (char === BACKSLASH) {
        // Consume the escaped character so a closing quote is not missed.
        output += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (next3 === '"""' || next3 === "'''") {
      tripleQuote = next3;
      index += 3;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

/** `'key': 'value'` and `"key": "value"`, in one pass over the file. */
const STRING_ENTRY = /(['"])([a-z_]+)\1\s*:\s*(['"])([^'"]*)\3/g;

/** `'key': True` / `False`. */
const BOOLEAN_ENTRY = /(['"])([a-z_]+)\1\s*:\s*(True|False)/g;

/** `'key': [ ... ]`, body captured non-greedily up to the first closing bracket. */
const LIST_ENTRY = /(['"])([a-z_]+)\1\s*:\s*\[([\s\S]*?)\]/g;

/** A quoted item inside a list body. */
const LIST_ITEM = /(['"])([^'"]+)\1/g;

/** Any key, used to report the ones this parser does not read. */
const ANY_KEY = /(['"])([a-z_]+)\1\s*:/g;

/** Collects every string-valued entry into a map, keyed by manifest key. */
function collectStrings(source: string): Map<string, string> {
  const values = new Map<string, string>();
  STRING_ENTRY.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = STRING_ENTRY.exec(source)) !== null) {
    const key = match[2];
    const value = match[4].trim();
    // First occurrence wins: a duplicate key in a Python dict is the earlier one
    // being overwritten, but a manifest with duplicates is malformed anyway and
    // the first is the more likely intent.
    if (!values.has(key) && value.length > 0) values.set(key, value);
  }

  return values;
}

function collectBooleans(source: string): Map<string, boolean> {
  const values = new Map<string, boolean>();
  BOOLEAN_ENTRY.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = BOOLEAN_ENTRY.exec(source)) !== null) {
    if (!values.has(match[2])) values.set(match[2], match[3] === 'True');
  }

  return values;
}

function collectLists(source: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  LIST_ENTRY.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = LIST_ENTRY.exec(source)) !== null) {
    if (values.has(match[2])) continue;

    const items: string[] = [];
    LIST_ITEM.lastIndex = 0;
    let item: RegExpExecArray | null;
    while ((item = LIST_ITEM.exec(match[3])) !== null) {
      const value = item[2].trim();
      if (value.length > 0) items.push(value);
    }
    values.set(match[2], items);
  }

  return values;
}

/**
 * Parses a manifest's text. Never executes it.
 *
 * `technicalName` is the module's directory name and is supplied by the caller,
 * because it is a filesystem fact rather than something the manifest states.
 */
export function parseOdooManifest(technicalName: string, source: string): OdooManifest {
  const cleaned = stripCommentsAndDocstrings(source.slice(0, MAX_MANIFEST_BYTES));

  const strings = collectStrings(cleaned);
  const booleans = collectBooleans(cleaned);
  const lists = collectLists(cleaned);

  const unparsedKeys: string[] = [];
  ANY_KEY.lastIndex = 0;
  let keyMatch: RegExpExecArray | null;
  while ((keyMatch = ANY_KEY.exec(cleaned)) !== null) {
    const key = keyMatch[2];
    if (!READ_KEYS.has(key) && !unparsedKeys.includes(key)) unparsedKeys.push(key);
  }

  return {
    technicalName,
    name: strings.get('name') ?? null,
    version: strings.get('version') ?? null,
    depends: lists.get('depends') ?? [],
    category: strings.get('category') ?? null,
    license: strings.get('license') ?? null,
    installable: booleans.get('installable') ?? null,
    applicationFlag: booleans.get('application') ?? null,
    unparsedKeys: unparsedKeys.slice(0, 40),
  };
}

/**
 * Derives the Odoo series from a manifest version.
 *
 * Odoo module versions are conventionally `<series>.<module version>`, so
 * `18.0.1.0.0` means the module targets Odoo 18.0. A module version with fewer
 * than three parts - `1.0` - is a module-only version that says nothing about the
 * series, and returns null rather than being misread as Odoo 1.0.
 */
export function odooSeriesFromVersion(version: string | null): string | null {
  if (!version) return null;

  const parts = version.split('.').filter((part) => part.length > 0);
  if (parts.length < 3) return null;

  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  // Sanity bound: a series outside this range is a misread, not an Odoo version.
  if (major < 7 || major > 40) return null;

  return `${major}.${minor}`;
}
