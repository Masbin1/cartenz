/**
 * Reads what an Odoo test run said (ADR-027).
 *
 * Odoo reports through its log rather than a machine-readable file, so this
 * parses that log. The exit code is what decides pass or fail — Odoo exits
 * non-zero when a test fails under `--stop-after-init` — and the parsing is for
 * the detail a reviewer needs: which module, how many tests, and what failed.
 *
 * Written to be tolerant. A log line that changes shape between Odoo versions
 * costs a less informative summary, never a wrong verdict, because the verdict
 * does not come from here.
 */

export interface ParsedFailure {
  /** The test that failed, as Odoo named it. */
  readonly test: string;
  /** The first line of the reason, when the log gives one. */
  readonly detail: string | null;
}

export interface ParsedTestOutput {
  /** Per-module counts, from Odoo's own stats lines. */
  readonly modules: readonly { name: string; tests: number; queries: number | null }[];
  readonly failures: readonly ParsedFailure[];
  /** True when Odoo reported loading the modules it was asked to install. */
  readonly modulesLoaded: boolean;
  /** A database or import error that stopped the run before any test ran. */
  readonly fatal: string | null;
}

/**
 * `odoo.tests.stats: linkederp_sales_modifier: 12 tests 3.41s 220 queries`
 *
 * The query count is optional: it is absent in some versions and on some paths.
 */
const STATS = /odoo\.tests\.stats:\s*([A-Za-z0-9_.]+):\s*(\d+)\s+tests?(?:\s+[\d.]+s)?(?:\s+(\d+)\s+queries)?/g;

/** `FAIL: TestSaleOrder.test_delivery_reference` and the ERROR equivalent. */
const FAILURE = /^(?:FAIL|ERROR):\s+(\S+)/;

/** What Odoo prints when it finishes installing. */
const LOADED = /Modules loaded\./;

/**
 * Errors that end a run before any test runs, and that a reviewer must not see
 * reported as "0 tests failed".
 */
const FATAL = [
  /psycopg2\.OperationalError:\s*(.+)/,
  /odoo\.exceptions\.\w+:\s*(.+)/,
  /ModuleNotFoundError:\s*(.+)/,
  /ImportError:\s*(.+)/,
  /FATAL:\s*(.+)/,
];

export function parseTestOutput(log: string): ParsedTestOutput {
  const lines = log.split('\n');

  const modules = [...log.matchAll(STATS)].map((match) => ({
    name: match[1],
    tests: Number(match[2]),
    queries: match[3] ? Number(match[3]) : null,
  }));

  const failures: ParsedFailure[] = [];
  for (const [index, line] of lines.entries()) {
    const match = FAILURE.exec(line.trim());
    if (!match) continue;

    // The reason is usually the next non-empty line that is not a separator.
    const detail =
      lines
        .slice(index + 1, index + 6)
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.length > 0 && !/^[-=]{3,}$/.test(candidate)) ?? null;

    failures.push({ test: match[1], detail });
  }

  let fatal: string | null = null;
  for (const pattern of FATAL) {
    const match = pattern.exec(log);
    if (match) {
      fatal = match[1].trim();
      break;
    }
  }

  return {
    modules,
    failures,
    modulesLoaded: LOADED.test(log),
    fatal,
  };
}

/**
 * A summary for the task record, in the shape the portal already renders.
 *
 * `passed` is derived rather than parsed: Odoo reports how many tests ran, not
 * how many passed, and subtracting the failures is the honest reading of that.
 */
export function summariseRun(
  parsed: ParsedTestOutput,
  exitCode: number,
): {
  passed: number;
  failed: number;
  skipped: number;
  simulated: boolean;
  suites: { name: string; status: 'passed' | 'failed' }[];
} {
  const total = parsed.modules.reduce((sum, module) => sum + module.tests, 0);
  const failed = parsed.failures.length;

  // A run that died before testing reports zero of everything, and the exit code
  // is what makes it a failure. Reporting "0 failed" for a crashed run would be
  // the most misleading thing this function could do.
  const failedModules = new Set(
    parsed.failures.map((failure) => failure.test.split('.')[0]).filter(Boolean),
  );

  return {
    passed: Math.max(0, total - failed),
    failed: exitCode === 0 ? failed : Math.max(failed, 1),
    skipped: 0,
    simulated: false,
    suites: parsed.modules.map((module) => ({
      name: module.name,
      status: failedModules.has(module.name) ? ('failed' as const) : ('passed' as const),
    })),
  };
}
