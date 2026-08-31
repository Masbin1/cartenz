/**
 * Which databases the platform's own credentials can reach (ADR-026).
 *
 * The platform is data-blind by design: no tool reads a database, and
 * `database_export` and `database_backup` are never grantable. That is a property
 * of the code.
 *
 * On premise it is deployed onto the same host as the customer's Odoo, sharing
 * one Postgres instance. If the platform's role can also connect to those
 * databases, then the only thing between the agent and a customer's production
 * records is that no code path asks — which is exactly the kind of guarantee that
 * lasts until someone adds a feature. ADR-021 removed a guarantee of that shape
 * for `git push`; this is the same shape, and the data matters more.
 *
 * The platform cannot fix this itself: revoking a privilege on a database it does
 * not own requires an operator. So it reports, precisely and loudly, and gives
 * the statement to run.
 */

/** A database the platform's role can open, other than its own. */
export interface ReachableDatabase {
  readonly name: string;
}

export interface IsolationReport {
  readonly ownDatabase: string;
  readonly reachable: readonly ReachableDatabase[];
  readonly isolated: boolean;
}

/**
 * Databases that carry no customer data and are not worth reporting.
 *
 * `postgres` is the maintenance database every client can reach and holds
 * nothing; the templates are not connectable in the ordinary sense.
 */
const UNINTERESTING = new Set(['postgres', 'template0', 'template1']);

/**
 * The SQL to check the privilege without opening a connection.
 *
 * `has_database_privilege` answers the question directly. Connecting to each
 * database in turn would answer it too, and would mean the platform had opened a
 * connection to a customer's production database in order to find out that it
 * should not be able to.
 */
export const ISOLATION_QUERY = `
  select datname
  from pg_database
  where datallowconn
    and not datistemplate
    and has_database_privilege(current_user, datname, 'CONNECT')
`;

export function buildReport(
  ownDatabase: string,
  rows: readonly { datname: string }[],
): IsolationReport {
  const reachable = rows
    .map((row) => row.datname)
    .filter((name) => name !== ownDatabase && !UNINTERESTING.has(name))
    .sort()
    .map((name) => ({ name }));

  return { ownDatabase, reachable, isolated: reachable.length === 0 };
}

/**
 * The warning, written for the person who has to act on it.
 *
 * Names every database rather than counting them, because "3 databases" invites a
 * shrug and `al3-prod-august` does not. The remediation is given as the statement
 * to run, because an instruction to "restrict privileges" is one more thing to
 * look up.
 */
export function describeReport(report: IsolationReport): string[] {
  if (report.isolated) {
    return [
      `Database isolation: the platform's credentials reach only ${report.ownDatabase}.`,
    ];
  }

  const names = report.reachable.map((entry) => entry.name);

  return [
    `Database isolation: the platform's credentials can also open ${names.length} other ` +
      `database(s) on this host: ${names.join(', ')}.`,
    'The platform never reads them — no tool opens a database, and database export and ' +
      'backup cannot be granted — but that is a property of the code rather than of the ' +
      'credentials, and on premise the credentials are what a customer is relying on.',
    'To close it, as a Postgres superuser:',
    ...names.map((name) => `  REVOKE CONNECT ON DATABASE "${name}" FROM CURRENT_PLATFORM_ROLE;`),
    'Replace CURRENT_PLATFORM_ROLE with the role in DATABASE_URL. Revoking PUBLIC first is ' +
      'usually what is wanted: REVOKE CONNECT ON DATABASE "x" FROM PUBLIC, then GRANT it back ' +
      'to the roles that need it.',
  ];
}
