import { parseTestOutput, summariseRun } from './odoo-test-output';

/**
 * Reading an Odoo test run's log (ADR-027).
 *
 * The verdict comes from the exit code, never from here, so these assert the
 * detail a reviewer needs and — more importantly — that a run which died before
 * testing is never reported as "0 failed".
 */
describe('parseTestOutput', () => {
  const statsLog = [
    '2026-08-29 10:00:00,000 INFO db odoo.modules.loading: Modules loaded.',
    '2026-08-29 10:00:01,000 INFO db odoo.tests.stats: linkederp_sales_modifier: 12 tests 3.41s 220 queries',
    '2026-08-29 10:00:02,000 INFO db odoo.tests.stats: linkederp_project_modifier: 4 tests 0.90s',
  ].join('\n');

  it('reads the per-module counts', () => {
    const parsed = parseTestOutput(statsLog);
    expect(parsed.modules).toEqual([
      { name: 'linkederp_sales_modifier', tests: 12, queries: 220 },
      { name: 'linkederp_project_modifier', tests: 4, queries: null },
    ]);
  });

  it('notices that the modules loaded', () => {
    expect(parseTestOutput(statsLog).modulesLoaded).toBe(true);
    expect(parseTestOutput('nothing here').modulesLoaded).toBe(false);
  });

  it('reads a failure and the line that explains it', () => {
    const log = [
      'FAIL: TestSaleOrder.test_delivery_reference',
      '----------------------------------------',
      'AssertionError: False is not true',
    ].join('\n');

    const parsed = parseTestOutput(log);
    expect(parsed.failures).toEqual([
      { test: 'TestSaleOrder.test_delivery_reference', detail: 'AssertionError: False is not true' },
    ]);
  });

  it('treats an ERROR as a failure, because Odoo does', () => {
    expect(parseTestOutput('ERROR: TestX.test_y').failures).toHaveLength(1);
  });

  it('reports a database error that stopped the run', () => {
    // The exact failure seen on the host this was written against, when the run
    // had no credential.
    const log = 'psycopg2.OperationalError: connection to server at "localhost" failed: fe_sendauth: no password supplied';
    expect(parseTestOutput(log).fatal).toContain('fe_sendauth');
  });

  it('reports a missing module rather than calling it a clean run', () => {
    expect(parseTestOutput('ModuleNotFoundError: No module named "odoo"').fatal).toContain(
      'No module named',
    );
  });

  it('finds nothing in an empty log rather than throwing', () => {
    const parsed = parseTestOutput('');
    expect(parsed.modules).toEqual([]);
    expect(parsed.failures).toEqual([]);
    expect(parsed.fatal).toBeNull();
  });
});

describe('summariseRun', () => {
  const twelveTests = parseTestOutput(
    'odoo.tests.stats: linkederp_sales_modifier: 12 tests 3.41s 220 queries',
  );

  it('derives passed from what ran, minus what failed', () => {
    // Odoo reports how many tests ran, not how many passed.
    const summary = summariseRun(twelveTests, 0);
    expect(summary).toMatchObject({ passed: 12, failed: 0, skipped: 0, simulated: false });
  });

  it('reports the suite as passed when nothing failed in it', () => {
    expect(summariseRun(twelveTests, 0).suites).toEqual([
      { name: 'linkederp_sales_modifier', status: 'passed' },
    ]);
  });

  it('never reports a crashed run as zero failures', () => {
    // The most misleading thing this could do: a run that died before any test
    // ran, reported as "0 failed" beside a green tick.
    const crashed = parseTestOutput('psycopg2.OperationalError: no password supplied');
    const summary = summariseRun(crashed, 1);

    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.passed).toBe(0);
  });

  it('trusts the exit code over the parsed count', () => {
    // A log whose failure lines this parser did not recognise still fails, because
    // the verdict is the exit code.
    const summary = summariseRun(twelveTests, 1);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
  });

  it('marks only the module that failed', () => {
    const parsed = parseTestOutput(
      [
        'odoo.tests.stats: mod_a: 3 tests 1.0s',
        'odoo.tests.stats: mod_b: 2 tests 1.0s',
        'FAIL: mod_b.TestThing.test_case',
      ].join('\n'),
    );

    expect(summariseRun(parsed, 1).suites).toEqual([
      { name: 'mod_a', status: 'passed' },
      { name: 'mod_b', status: 'failed' },
    ]);
  });
});
