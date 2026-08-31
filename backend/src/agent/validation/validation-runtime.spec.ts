import {
  parseRuntimes,
  selectRuntime,
  toSeries,
  UnknownOdooRuntimeError,
} from './odoo-runtime-registry';
import {
  assertScratchDatabase,
  isScratchDatabase,
  ScratchDatabaseError,
  scratchDatabaseName,
} from './scratch-database';
import { buildOdooConf, buildTestArguments } from './odoo-conf';

/**
 * Validation runtime selection and containment (ADR-027).
 *
 * Written against a real consultancy host: an Odoo 19.0 core and a 17.0 core side
 * by side, one shared enterprise directory, per-client addons, and twelve Odoo
 * databases owned by a Postgres superuser called `odoo` — one of them
 * `al3-prod-august`.
 */
describe('toSeries', () => {
  it('treats the forms a repository actually uses as the same runtime', () => {
    // Manifests carry 19.0.1.0.3, the release carries 19.0, people write 19.
    for (const version of ['19', '19.0', '19.0.1.0.3']) {
      expect(toSeries(version)).toBe('19.0');
    }
  });

  it('keeps a non-zero minor, because saas series exist', () => {
    expect(toSeries('16.3')).toBe('16.3');
  });

  it('returns an empty series for nothing recognisable', () => {
    expect(toSeries('')).toBe('');
    expect(toSeries('   ')).toBe('');
  });
});

describe('parseRuntimes', () => {
  it('reads several series, as a consultancy host has', () => {
    const runtimes = parseRuntimes('19.0=/opt/odoo19, 17.0=/opt/odoo17');
    expect(runtimes).toEqual([
      { series: '19.0', corePath: '/opt/odoo19', sharedAddonPaths: [] },
      { series: '17.0', corePath: '/opt/odoo17', sharedAddonPaths: [] },
    ]);
  });

  it('applies the shared addon directories to every series', () => {
    // On the host this serves, one enterprise directory is shared across versions.
    const runtimes = parseRuntimes('19.0=/opt/odoo19,17.0=/opt/odoo17', ['/opt/enterprise']);
    expect(runtimes.every((r) => r.sharedAddonPaths.includes('/opt/enterprise'))).toBe(true);
  });

  it('refuses a relative core path', () => {
    // It would resolve against whatever directory the worker started in.
    expect(() => parseRuntimes('19.0=odoo19')).toThrow(/absolute path/);
  });

  it('refuses an entry with no series', () => {
    expect(() => parseRuntimes('=/opt/odoo19')).toThrow(/no series/);
    expect(() => parseRuntimes('/opt/odoo19')).toThrow(/series=path/);
  });

  it('ignores empty entries rather than failing on a trailing comma', () => {
    expect(parseRuntimes('19.0=/opt/odoo19,')).toHaveLength(1);
  });
});

describe('selectRuntime', () => {
  const runtimes = parseRuntimes('19.0=/opt/odoo19,18.0=/opt/odoo18,17.0=/opt/odoo17');

  it('selects the runtime for the detected series', () => {
    expect(selectRuntime(runtimes, '19.0.1.0.3').corePath).toBe('/opt/odoo19');
    expect(selectRuntime(runtimes, '18.0').corePath).toBe('/opt/odoo18');
  });

  it('refuses rather than running 20.0 code against a 19.0 core', () => {
    // The failure would be a page of import errors that look like the change is
    // broken when the runtime is simply wrong.
    expect(() => selectRuntime(runtimes, '20.0')).toThrow(UnknownOdooRuntimeError);
    expect(() => selectRuntime(runtimes, '20.0')).toThrow(/19\.0, 18\.0, 17\.0/);
  });

  it('says what to configure when nothing is', () => {
    expect(() => selectRuntime([], '19.0')).toThrow(/ODOO_RUNTIMES/);
  });

  it('refuses when no version was detected', () => {
    expect(() => selectRuntime(runtimes, null)).toThrow(UnknownOdooRuntimeError);
  });
});

describe('scratchDatabaseName', () => {
  it('carries a prefix no Odoo database would have', () => {
    expect(scratchDatabaseName('task_856328', 1)).toBe('linkederp_validation_task_856328_1');
  });

  it('distinguishes attempts, so a retry does not reuse a database', () => {
    expect(scratchDatabaseName('task_1', 1)).not.toBe(scratchDatabaseName('task_1', 2));
  });

  it('folds the case Postgres would fold anyway', () => {
    expect(scratchDatabaseName('TASK_ABC', 1)).toContain('task_abc');
  });

  it('refuses a name Postgres would silently truncate', () => {
    // Two runs differing only after the 63rd byte would become one database.
    expect(() => scratchDatabaseName('t'.repeat(60), 1)).toThrow(/truncate/);
  });

  it('refuses a reference that produces no name at all', () => {
    expect(() => scratchDatabaseName('///', 1)).toThrow(ScratchDatabaseError);
  });
});

describe('assertScratchDatabase', () => {
  // The names on the host this was written against.
  const customerDatabases = [
    'al3-prod-august',
    'al3-live',
    'omnisurge',
    'linkederp-development',
    'postgres',
  ];

  it('refuses to drop a customer database, however it was passed in', () => {
    for (const name of customerDatabases) {
      expect(() => assertScratchDatabase(name, 'drop')).toThrow(ScratchDatabaseError);
      expect(() => assertScratchDatabase(name, 'drop')).toThrow(new RegExp(name));
    }
  });

  it('refuses to create one too', () => {
    expect(() => assertScratchDatabase('al3-prod-august', 'create')).toThrow(/not a validation/);
  });

  it('permits a name it generated', () => {
    expect(() => assertScratchDatabase(scratchDatabaseName('task_1', 1), 'drop')).not.toThrow();
  });

  it('is not fooled by a name that merely contains the prefix', () => {
    expect(isScratchDatabase('customer_linkederp_validation_db')).toBe(false);
  });
});

describe('buildOdooConf', () => {
  const conf = buildOdooConf({
    coreAddonsPath: '/opt/odoo19/addons',
    sharedAddonPaths: ['/opt/enterprise'],
    workspaceAddonsPath: '/var/workspaces/task_1/repo',
    databaseName: 'linkederp_validation_task_1_1',
    databaseHost: 'localhost',
    databasePort: 5432,
    databaseUser: 'linkederp_validation',
  });

  it('puts the workspace ahead of the shared and core directories', () => {
    // The change under test must win over the same module installed elsewhere.
    const path = conf.split('\n').find((line) => line.startsWith('addons_path'))!;
    expect(path.indexOf('/var/workspaces')).toBeLessThan(path.indexOf('/opt/enterprise'));
    expect(path.indexOf('/opt/enterprise')).toBeLessThan(path.indexOf('/opt/odoo19/addons'));
  });

  it('holds no password', () => {
    // It reaches the process through the environment, for the life of that
    // process, rather than a file another user on the host can read.
    expect(conf).not.toMatch(/passwd|password/i);
  });

  it('does not expose the database list or the database manager', () => {
    expect(conf).toContain('list_db = False');
  });

  it('runs no cron and no worker processes', () => {
    expect(conf).toContain('max_cron_threads = 0');
    expect(conf).toContain('workers = 0');
  });
});

describe('buildTestArguments', () => {
  it('stops after init, so this is a validation and not a server', () => {
    const args = buildTestArguments({
      confPath: '/tmp/x.conf',
      databaseName: 'linkederp_validation_task_1_1',
      modules: ['linkederp_sales_modifier'],
    });

    expect(args).toContain('--stop-after-init');
    expect(args).toContain('--test-enable');
    expect(args.join(' ')).toContain('-d linkederp_validation_task_1_1');
  });

  it('refuses a run with no module, which would install nothing and test nothing', () => {
    expect(() =>
      buildTestArguments({ confPath: '/tmp/x.conf', databaseName: 'd', modules: [] }),
    ).toThrow(/at least one module/);
  });
});
