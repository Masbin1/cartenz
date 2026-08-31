import { buildReport, describeReport } from './database-isolation';

/**
 * On-premise database isolation (ADR-026).
 *
 * Written from a real deployment: the platform's own credentials could open
 * twelve other databases on the host, including one called `al3-prod-august`.
 * Nothing read them, because no tool opens a database — but that is a property of
 * the code, and on premise the credentials are what the customer is relying on.
 */
describe('buildReport', () => {
  const rows = (...names: string[]) => names.map((datname) => ({ datname }));

  it('reports the platform alone as isolated', () => {
    expect(buildReport('linkederp_ai', rows('linkederp_ai')).isolated).toBe(true);
  });

  it('does not count the maintenance database or the templates', () => {
    // Every client can open `postgres`; it holds nothing and naming it would make
    // a clean deployment look unclean.
    const report = buildReport('linkederp_ai', rows('linkederp_ai', 'postgres', 'template1'));
    expect(report.isolated).toBe(true);
    expect(report.reachable).toEqual([]);
  });

  it('reports a customer database as reachable', () => {
    const report = buildReport('linkederp_ai', rows('linkederp_ai', 'al3-prod-august'));
    expect(report.isolated).toBe(false);
    expect(report.reachable.map((entry) => entry.name)).toEqual(['al3-prod-august']);
  });

  it('sorts them, so two runs of the same deployment read the same', () => {
    const report = buildReport('linkederp_ai', rows('omnisurge', 'al3', 'vania-incentive-test'));
    expect(report.reachable.map((entry) => entry.name)).toEqual([
      'al3',
      'omnisurge',
      'vania-incentive-test',
    ]);
  });
});

describe('describeReport', () => {
  it('says so plainly when the deployment is isolated', () => {
    const lines = describeReport(buildReport('linkederp_ai', [{ datname: 'linkederp_ai' }]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('only linkederp_ai');
  });

  it('names every reachable database rather than counting them', () => {
    // "3 databases" invites a shrug. "al3-prod-august" does not.
    const lines = describeReport(
      buildReport('linkederp_ai', [{ datname: 'al3-prod-august' }, { datname: 'omnisurge' }]),
    ).join('\n');

    expect(lines).toContain('al3-prod-august');
    expect(lines).toContain('omnisurge');
  });

  it('gives the statement to run rather than an instruction to look up', () => {
    const lines = describeReport(buildReport('linkederp_ai', [{ datname: 'al3' }])).join('\n');
    expect(lines).toContain('REVOKE CONNECT ON DATABASE "al3"');
  });

  it('is honest that the platform does not read them', () => {
    // The warning must not imply data has been touched. It has not: no tool opens
    // a database, and the check itself uses has_database_privilege rather than
    // connecting.
    const lines = describeReport(buildReport('linkederp_ai', [{ datname: 'al3' }])).join('\n');
    expect(lines).toContain('never reads them');
  });
});
