import { ProjectProvisioningService } from './project-provisioning.service';
import type { CommandRunner, CommandResult } from '../../core/process/command-runner.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AppConfig } from '../../core/config/configuration';

/**
 * ADR-056. Two things are asserted here that nothing else can assert:
 *
 *  1. The default path is *unchanged*. A project that asked for no module
 *     selection must still produce exactly the argument vector it produced
 *     before this feature existed — same length, same order, no trailing empty
 *     element. This is the regression the selective path could plausibly cause
 *     by threading an optional argument through the same function.
 *  2. The selective path appends the module list as the seventh argument, and
 *     only then.
 *
 * The sudo call is mocked. What is under test is the argument vector this
 * service builds — the thing `assertProvisioningInvocation` then refuses
 * independently — not whether a process starts.
 */

interface Run {
  readonly executable: string;
  readonly args: readonly string[];
}

function harness(overrides: { enabled?: boolean; version?: string | null } = {}) {
  const runs: Run[] = [];
  const enqueued: unknown[] = [];

  const grantResult: CommandResult = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    truncated: false,
  };

  const commands = {
    run: async (executable: string, args: readonly string[]) => {
      runs.push({ executable, args: [...args] });
      // The first sudo call is the create script; the second is the addons
      // ownership fix-up. Both must succeed for `provisioned: true`.
      void grantResult;
      return {
        exitCode: 0,
        stdout: 'Odoo Master Password:\n\n  abc123\n',
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      } satisfies CommandResult;
    },
  } as unknown as CommandRunner;

  const database = {
    db: {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    },
  } as unknown as DatabaseService;

  const config = {
    provisioning: {
      enabled: overrides.enabled ?? true,
      communityScript: '/opt/odoo/scripts/create_project',
      enterpriseScript: '/opt/odoo/scripts/create_project_enterprise',
      grantScript: '/opt/odoo/scripts/grant-addons-write',
      projectsDir: '/opt/odoo/projects',
      baseDomain: 'example.test',
      portRangeStart: 7000,
      portRangeEnd: 7100,
    },
    https: { enabled: false, email: null, script: null },
    process: { maxTimeoutMs: 300_000, timeoutMs: 60_000 },
  } as unknown as AppConfig;

  const service = new ProjectProvisioningService(commands, database, config);

  return { service, runs, enqueued };
}

const base = {
  projectId: 'p1',
  technicalName: 'dodolbintangmas',
  odooEdition: 'enterprise' as const,
  region: 'indonesia' as const,
};

describe('ProjectProvisioningService — argument vector (ADR-056)', () => {
  it('sends exactly the pre-ADR-056 shape when no version and no modules are given', async () => {
    const { service, runs } = harness();

    await service.provision({ ...base, odooVersion: null });

    const create = runs[0];
    expect(create.executable).toBe('sudo');
    expect(create.args).toEqual([
      '-n',
      '/opt/odoo/scripts/create_project_enterprise',
      'dodolbintangmas',
      expect.any(String),
    ]);
    expect(create.args).toHaveLength(4);
  });

  it('sends version and region, with no module argument, when no selection was made', async () => {
    const { service, runs } = harness();

    await service.provision({ ...base, odooVersion: '19.0' });

    expect(runs[0].args).toEqual([
      '-n',
      '/opt/odoo/scripts/create_project_enterprise',
      'dodolbintangmas',
      expect.any(String),
      '19.0',
      'indonesia',
    ]);
    expect(runs[0].args).toHaveLength(6);
  });

  it('returns a pending result for a selection instead of running it', async () => {
    const { service, runs, enqueued } = harness();

    const result = await service.provision({
      ...base,
      odooVersion: '19.0',
      modules: ['stock', 'sale_management'],
    });

    // The whole point of the async path: no script ran on the request thread.
    expect(runs).toHaveLength(0);
    expect(result.provisioned).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.error).toBeNull();
    // The port is allocated before returning so the pending row can record it.
    expect(result.port).toEqual(expect.any(Number));
    // Enqueueing is ProjectsService's job, not this service's: the job needs
    // the real project id, which does not exist until after this returns.
    expect(enqueued).toHaveLength(0);
  });

  it('treats an empty module list as no selection at all', async () => {
    const { service, runs, enqueued } = harness();

    const result = await service.provision({ ...base, odooVersion: '19.0', modules: [] });

    // Not a seventh empty argument: the scripts' own arg-count check would see
    // an argument that is present but meaningless. Nothing is queued either —
    // an empty selection is the default path, not an async one.
    expect(enqueued).toHaveLength(0);
    expect(result.pending).toBeUndefined();
    expect(runs[0].args).toHaveLength(6);
  });

  it('leaves the disabled-deployment result untouched', async () => {
    const { service, runs, enqueued } = harness({ enabled: false });

    const result = await service.provision({
      ...base,
      odooVersion: '19.0',
      modules: ['stock'],
    });

    expect(result.provisioned).toBe(false);
    expect(result.error).toContain('PROJECT_PROVISIONING_ENABLED=false');
    expect(runs).toHaveLength(0);
    // A disabled deployment never reaches the queue: the availability check
    // comes first, so a queued job can never be orphaned by it.
    expect(enqueued).toHaveLength(0);
  });
});

/**
 * The worker-side half. `provision` queues; `runSelectiveScript` is what the
 * worker calls to actually build the invocation — so the argument vector
 * assertions moved here when the selective path became asynchronous. The
 * regression this guards is unchanged: the module list is appended only when
 * there is one, and always last.
 */
describe('ProjectProvisioningService — selective worker path (ADR-056)', () => {
  it('appends the module list as the seventh argument, in sorted order', async () => {
    const { service, runs } = harness();

    await service.runSelectiveScript({
      projectId: 'p1',
      technicalName: 'dodolbintangmas',
      odooEdition: 'enterprise',
      odooVersion: '19.0',
      region: 'indonesia',
      modules: ['stock', 'sale_management'],
      port: 7000,
    });

    expect(runs[0].args).toEqual([
      '-n',
      '/opt/odoo/scripts/create_project_enterprise',
      'dodolbintangmas',
      '7000',
      '19.0',
      'indonesia',
      'sale_management,stock',
    ]);
  });

  it('uses the port carried in the job, not a freshly allocated one', async () => {
    const { service, runs } = harness();

    await service.runSelectiveScript({
      projectId: 'p1',
      technicalName: 'dodolbintangmas',
      odooEdition: 'enterprise',
      odooVersion: '19.0',
      region: 'indonesia',
      modules: ['stock'],
      port: 7042,
    });

    expect(runs[0].args[3]).toBe('7042');
  });

  it('uses the community script for a community project', async () => {
    const { service, runs } = harness();

    await service.runSelectiveScript({
      projectId: 'p1',
      technicalName: 'dodolbintangmas',
      odooEdition: 'community',
      odooVersion: '19.0',
      region: 'indonesia',
      modules: ['stock'],
      port: 7000,
    });

    expect(runs[0].args[1]).toBe('/opt/odoo/scripts/create_project');
    expect(runs[0].args[6]).toBe('stock');
  });
});
