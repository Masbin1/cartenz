import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateModules, resolveDependencyClosure, type CatalogModule } from './odoo-module-catalog';

/**
 * ADR-056. The creation form offers the modules that are really on this host,
 * so the enumeration that feeds it has to read the same manifests the host's
 * template builder reads, and skip the same things it skips.
 *
 * These use real files in a temporary directory rather than a mocked `fs`,
 * because what has to be true is that a module directory laid out the way Odoo
 * lays one out is found — a mocked readdir would prove the code calls a
 * function.
 */
describe('enumerateModules', () => {
  let root: string;
  let addons: string;
  let enterprise: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'module-catalog-'));
    addons = join(root, 'addons');
    enterprise = join(root, 'enterprise');
    await mkdir(addons, { recursive: true });
    await mkdir(enterprise, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeManifest = async (base: string, name: string, body: string) => {
    await mkdir(join(base, name), { recursive: true });
    await writeFile(join(base, name, '__manifest__.py'), body, 'utf8');
  };

  it('reads the fields the picker needs, and marks an app as an app', async () => {
    await writeManifest(
      addons,
      'sale_management',
      "{'name': 'Sales', 'category': 'Sales/Sales', 'depends': ['sale', 'mail'], 'application': True}",
    );
    await writeManifest(addons, 'sale', "{'name': 'Sales', 'depends': ['base']}");

    const modules = await enumerateModules([addons]);
    const sale = modules.find((m) => m.technicalName === 'sale_management');

    expect(sale).toEqual({
      technicalName: 'sale_management',
      name: 'Sales',
      category: 'Sales/Sales',
      isApplication: true,
      depends: ['sale', 'mail'],
    });
    expect(modules.find((m) => m.technicalName === 'sale')?.isApplication).toBe(false);
  });

  /**
   * The picker is a catalogue of things a person can install. A module Odoo
   * itself would refuse to install must not appear as a choice.
   */
  it('excludes a module whose manifest says installable is false', async () => {
    await writeManifest(addons, 'real', "{'name': 'Real'}");
    await writeManifest(addons, 'not_installable', "{'name': 'No', 'installable': False}");

    const names = (await enumerateModules([addons])).map((m) => m.technicalName);
    expect(names).toContain('real');
    expect(names).not.toContain('not_installable');
  });

  /** Same skipping the host's `list_modules()` does, so the two never disagree. */
  it('skips test modules and directories without a manifest', async () => {
    await writeManifest(addons, 'test_whatever', "{'name': 'Test'}");
    await writeManifest(addons, '.hidden', "{'name': 'Hidden'}");
    await mkdir(join(addons, 'not_a_module'), { recursive: true });
    await writeManifest(addons, 'genuine', "{'name': 'Genuine'}");

    const names = (await enumerateModules([addons])).map((m) => m.technicalName);
    expect(names).toEqual(['genuine']);
  });

  /**
   * An enterprise project reads both paths, and the same module name can exist
   * in both. The picker must offer it once.
   */
  it('de-duplicates a technical name present in two addon paths', async () => {
    await writeManifest(addons, 'shared', "{'name': 'Community copy'}");
    await writeManifest(enterprise, 'shared', "{'name': 'Enterprise copy'}");

    const modules = await enumerateModules([addons, enterprise]);
    expect(modules.filter((m) => m.technicalName === 'shared')).toHaveLength(1);
  });

  it('sorts by display name so the picker order is stable', async () => {
    await writeManifest(addons, 'zzz', "{'name': 'Accounts'}");
    await writeManifest(addons, 'aaa', "{'name': 'Warehouse'}");

    expect((await enumerateModules([addons])).map((m) => m.name)).toEqual([
      'Accounts',
      'Warehouse',
    ]);
  });

  /**
   * A manifest with no `name` still has to be selectable: Odoo installs it, and
   * a picker that hides it would make a module unreachable through the portal.
   */
  it('falls back to the technical name when a manifest has no name', async () => {
    await writeManifest(addons, 'unnamed_mod', "{'depends': ['base']}");

    const [module] = await enumerateModules([addons]);
    expect(module).toMatchObject({
      technicalName: 'unnamed_mod',
      name: 'unnamed_mod',
      category: null,
      depends: ['base'],
    });
  });

  /** An addon path that is not on this host is skipped, not a thrown error. */
  it('skips an addon path that does not exist', async () => {
    await writeManifest(addons, 'present', "{'name': 'Present'}");

    const modules = await enumerateModules([addons, join(root, 'nowhere')]);
    expect(modules.map((m) => m.technicalName)).toEqual(['present']);
  });
});

/**
 * ADR-056. Selecting one module has to install what it depends on, or Odoo
 * installs a module whose dependencies are missing. The form must not ask a
 * person to tick every dependency by hand.
 */
describe('resolveDependencyClosure', () => {
  const module = (
    technicalName: string,
    depends: readonly string[] = [],
  ): CatalogModule => ({
    technicalName,
    name: technicalName,
    category: null,
    isApplication: false,
    depends,
  });

  const catalog = [module('a', ['b']), module('b', ['c']), module('c'), module('lonely')];

  it('pulls a chain of dependencies transitively', () => {
    expect(resolveDependencyClosure(['a'], catalog)).toEqual({
      resolved: ['a', 'b', 'c'],
      unknown: [],
    });
  });

  it('resolves each selected module, not only the first', () => {
    const { resolved } = resolveDependencyClosure(['lonely', 'b'], catalog);
    expect(resolved).toEqual(['b', 'c', 'lonely']);
  });

  /**
   * Odoo's own `base` depends on `base` in some releases, and third-party
   * modules have shipped self-referential and circular `depends`. A visited
   * set is what stops the walk hanging on a request, rather than a timeout.
   */
  it('does not loop on a self-referential or circular depends', () => {
    const circular = [module('x', ['y']), module('y', ['x']), module('self', ['self'])];
    expect(resolveDependencyClosure(['x'], circular).resolved).toEqual(['x', 'y']);
    expect(resolveDependencyClosure(['self'], circular).resolved).toEqual(['self']);
  });

  it('reports an unknown selected name and leaves it out of the resolution', () => {
    expect(resolveDependencyClosure(['a', 'ghost'], catalog)).toEqual({
      resolved: ['a', 'b', 'c'],
      unknown: ['ghost'],
    });
  });

  /**
   * A dependency the catalog does not carry is a host fact, not user error —
   * it must not be reported as an unknown *selection*.
   */
  it('does not report a missing dependency as an unknown selection', () => {
    const { unknown } = resolveDependencyClosure(['needs_missing'], [module('needs_missing', ['nowhere'])]);
    expect(unknown).toEqual([]);
  });

  it('returns an empty resolution for an empty selection', () => {
    expect(resolveDependencyClosure([], catalog)).toEqual({ resolved: [], unknown: [] });
  });
});
