import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OdooValidationRunner } from './odoo-validation-runner';
import type { CommandRunner } from '../../core/process/command-runner.service';
import type { AppConfig } from '../../core/config/configuration';

/**
 * The runner's refusals (ADR-027).
 *
 * Every test here asserts that nothing was executed, which is why the command
 * runner is a stub that fails the test if it is ever called. The paths that do
 * execute need a Postgres role and an Odoo core, and are exercised by the
 * validation smoke test rather than here.
 */
describe('OdooValidationRunner', () => {
  let workspace: string;

  const neverRuns = {
    run: () => {
      throw new Error('the command runner must not be reached on a skipped run');
    },
  } as unknown as CommandRunner;

  const config = (validation: Partial<AppConfig['validation']>): AppConfig =>
    ({
      validation: {
        enabled: true,
        runtimes: '19.0=/opt/odoo19',
        sharedAddonPaths: [],
        databaseUser: 'linkederp_validation',
        databasePassword: 'secret',
        databaseHost: '127.0.0.1',
        databasePort: 5432,
        timeoutMs: 900_000,
        ...validation,
      },
    }) as AppConfig;

  const request = (overrides: Record<string, unknown> = {}) => ({
    taskReference: 'task_1',
    attempt: 1,
    repositoryPath: join(workspace, 'repository'),
    metadataPath: join(workspace, 'metadata'),
    odooVersion: '19.0',
    modules: ['linkederp_sales_modifier'],
    ...overrides,
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'linkederp-validation-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('is unavailable when validation is disabled', async () => {
    const runner = new OdooValidationRunner(neverRuns, config({ enabled: false }));

    expect(runner.available).toBe(false);
    const outcome = await runner.run(request());

    expect(outcome.ran).toBe(false);
    expect(outcome.skippedReason).toContain('VALIDATION_ENABLED=false');
    expect(outcome.results).toBeNull();
  });

  it('says what to configure when no runtime is set', async () => {
    const runner = new OdooValidationRunner(neverRuns, config({ runtimes: '' }));

    expect(runner.available).toBe(false);
    expect((await runner.run(request())).skippedReason).toContain('ODOO_RUNTIMES');
  });

  it('refuses to run without a validation role, rather than falling back to another', async () => {
    // The failure this prevents is the platform quietly authenticating as
    // whatever role happens to be configured elsewhere - which on premise is a
    // cluster superuser owning the customer databases.
    const runner = new OdooValidationRunner(neverRuns, config({ databaseUser: '' }));
    const outcome = await runner.run(request());

    expect(outcome.ran).toBe(false);
    expect(outcome.skippedReason).toContain('VALIDATION_DB_USER');
    expect(outcome.skippedReason).toContain('never the Odoo role');
  });

  it('refuses without a password too', async () => {
    const runner = new OdooValidationRunner(neverRuns, config({ databasePassword: '' }));
    expect((await runner.run(request())).skippedReason).toContain('VALIDATION_DB_PASSWORD');
  });

  it('skips a series it has no runtime for, naming what it has', async () => {
    // Rather than running 20.0 code against a 19.0 core.
    const runner = new OdooValidationRunner(neverRuns, config({}));
    const outcome = await runner.run(request({ odooVersion: '20.0' }));

    expect(outcome.ran).toBe(false);
    expect(outcome.skippedReason).toContain('19.0');
    expect(outcome.runtime).toBeNull();
  });

  it('skips when no module was touched', async () => {
    const runner = new OdooValidationRunner(neverRuns, config({}));
    const outcome = await runner.run(request({ modules: [] }));

    expect(outcome.ran).toBe(false);
    expect(outcome.skippedReason).toContain('nothing to install and test');
  });

  it('survives a malformed ODOO_RUNTIMES rather than failing to construct', async () => {
    // One broken capability must not stop the platform booting.
    const runner = new OdooValidationRunner(neverRuns, config({ runtimes: 'nonsense' }));

    expect(runner.available).toBe(false);
    expect((await runner.run(request())).ran).toBe(false);
  });

  it('reports availability only when everything it needs is present', async () => {
    expect(new OdooValidationRunner(neverRuns, config({})).available).toBe(true);
  });
});
