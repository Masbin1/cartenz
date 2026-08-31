import type { BoundaryFinding } from './boundary-types';

/**
 * The sensitive-data filter (chapter 12, second filter).
 *
 * This is the one that catches a database dump, and it works structurally rather
 * than by pattern. No per-value rule can distinguish a table of customer records
 * from a table of anything else - every individual cell looks ordinary. What
 * gives it away is the shape: many rows, consistent columns, and headers naming
 * the fields chapter 12 forbids.
 *
 * It refuses rather than redacts. A redacted database dump is still a database
 * dump: its row count, its column names and its structure would reach the
 * provider, and chapter 12 forbids the material, not merely its values.
 */

export interface SensitiveDataResult {
  readonly findings: readonly BoundaryFinding[];
  /** Present when the material must not be sent at all. */
  readonly refusalReason?: string;
}

/**
 * Column names that identify a table as customer, employee or financial data.
 *
 * Drawn from chapter 12's own list and from the Odoo models it names. A header
 * row containing several of these is a record set, whatever the file extension
 * says.
 */
const RECORD_COLUMN_NAMES = [
  'first_name',
  'last_name',
  'full_name',
  'customer_name',
  'partner_name',
  'employee_name',
  'email',
  'email_from',
  'phone',
  'mobile',
  'street',
  'street2',
  'zip',
  'vat',
  'id_number',
  'passport',
  'date_of_birth',
  'birthday',
  'bank_account',
  'iban',
  'account_number',
  'salary',
  'wage',
  'amount_total',
  'amount_untaxed',
  'invoice_number',
  'card_number',
];

/** Markers that identify the material as a dump rather than as source. */
const DUMP_MARKERS: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: 'pg_dump_output', pattern: /^--\s*PostgreSQL database dump/im },
  { rule: 'pg_copy_block', pattern: /^COPY\s+[A-Za-z_."]+\s*\([^)]*\)\s+FROM\s+stdin;/im },
  { rule: 'sql_insert_batch', pattern: /INSERT\s+INTO\s+[A-Za-z_."]+\s*\([^)]*\)\s*VALUES/gi },
  { rule: 'mysql_dump_output', pattern: /^--\s*MySQL dump/im },
  { rule: 'psql_result_footer', pattern: /^\(\d+\s+rows?\)\s*$/im },
];

/** Rows below this are a code sample; above it, a data set. */
const RECORD_SET_MIN_ROWS = 4;
/** Distinct record-shaped column names before a header is treated as a record set. */
const RECORD_SET_MIN_COLUMNS = 3;

/**
 * Detects delimiter-separated record sets: CSV, and the pipe-aligned output psql
 * produces.
 *
 * Requires both a header naming several record fields and enough consistent rows
 * beneath it. Either alone is too weak - a source file can contain a line of
 * comma-separated field names, and any file has many lines with commas in them.
 */
function detectRecordSet(content: string): BoundaryFinding | null {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < RECORD_SET_MIN_ROWS + 1) return null;

  for (const delimiter of [',', '|', '\t', ';']) {
    for (let index = 0; index < Math.min(lines.length, 20); index += 1) {
      const header = lines[index].toLowerCase();
      const columns = header.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''));
      if (columns.length < RECORD_SET_MIN_COLUMNS) continue;

      const matched = columns.filter((column) => RECORD_COLUMN_NAMES.includes(column)).length;
      if (matched < RECORD_SET_MIN_COLUMNS) continue;

      // A header alone is not a data set. Count the rows beneath it that have
      // the same column count.
      const following = lines.slice(index + 1, index + 40);
      const consistent = following.filter(
        (line) => line.split(delimiter).length === columns.length,
      ).length;

      if (consistent >= RECORD_SET_MIN_ROWS) {
        return {
          kind: 'structured_data',
          rule: 'delimited_record_set',
          occurrences: consistent,
        };
      }
    }
  }

  return null;
}

/**
 * Detects a JSON array of record-shaped objects.
 *
 * An Odoo data export and an API response both take this form, and neither is
 * distinguishable from the other by content. The test is the same as for CSV:
 * repeated objects carrying the field names chapter 12 protects.
 */
function detectJsonRecordArray(content: string): BoundaryFinding | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.includes('": [')) return null;

  const keyPattern = /"([a-z_]+)"\s*:/gi;
  const counts = new Map<string, number>();

  let match: RegExpExecArray | null;
  while ((match = keyPattern.exec(trimmed)) !== null) {
    const key = match[1].toLowerCase();
    if (RECORD_COLUMN_NAMES.includes(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // Several record fields, each appearing several times, is an array of records
  // rather than one object that happens to have an email field.
  const repeated = [...counts.values()].filter((count) => count >= RECORD_SET_MIN_ROWS).length;
  if (counts.size >= RECORD_SET_MIN_COLUMNS && repeated >= RECORD_SET_MIN_COLUMNS) {
    return {
      kind: 'structured_data',
      rule: 'json_record_array',
      occurrences: Math.max(...counts.values()),
    };
  }

  return null;
}

/**
 * Inspects material for structures chapter 12 forbids.
 *
 * Returns findings and, where the material must not be sent at all, the reason.
 * It never rewrites content: this filter's answer is yes or no.
 */
export function inspectForSensitiveData(content: string): SensitiveDataResult {
  const findings: BoundaryFinding[] = [];

  for (const marker of DUMP_MARKERS) {
    const pattern = new RegExp(marker.pattern.source, marker.pattern.flags);
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        kind: 'structured_data',
        rule: marker.rule,
        occurrences: matches.length,
      });
    }
  }

  const recordSet = detectRecordSet(content);
  if (recordSet) findings.push(recordSet);

  const jsonRecords = detectJsonRecordArray(content);
  if (jsonRecords) findings.push(jsonRecords);

  if (findings.length === 0) return { findings };

  return {
    findings,
    refusalReason:
      `the material contains ${findings.map((finding) => finding.rule).join(', ')}, ` +
      'which is database or record content rather than source code',
  };
}
