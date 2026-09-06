import { changedModules } from './changed-modules';

/**
 * Mapping a change back to the modules that must be installed (ADR-027).
 *
 * The paths here are the ones the agent actually produced against the LinkedERP
 * repository.
 */
describe('changedModules', () => {
  it('maps a real change to its module', () => {
    expect(
      changedModules([
        'linkederp_sales_modifier/models/sale_order.py',
        'linkederp_sales_modifier/views/sale_order_views.xml',
      ]),
    ).toEqual(['linkederp_sales_modifier']);
  });

  it('returns each module once, sorted', () => {
    expect(
      changedModules([
        'linkederp_project_modifier/models/task.py',
        'linkederp_sales_modifier/models/sale_order.py',
        'linkederp_project_modifier/views/task_views.xml',
      ]),
    ).toEqual(['linkederp_project_modifier', 'linkederp_sales_modifier']);
  });

  it('ignores a file at the repository root', () => {
    // There is no module to install for a README.
    expect(changedModules(['README.md', '.gitignore'])).toEqual([]);
  });

  it('ignores directories that are never addons', () => {
    expect(changedModules(['docs/architecture.md', '.github/workflows/ci.yml'])).toEqual([]);
  });

  it('tolerates a leading ./ or /', () => {
    expect(changedModules(['./mod_a/models/x.py', '/mod_b/models/y.py'])).toEqual([
      'mod_a',
      'mod_b',
    ]);
  });

  it('returns nothing for nothing', () => {
    expect(changedModules([])).toEqual([]);
  });

  /**
   * ADR-034. A project created by the platform holds its modules in `addons/`
   * (ADR-033). Without skipping that segment every changed file maps to the
   * literal "addons" and the run tries to install a module by that name.
   */
  describe('the addons/ layout (ADR-033)', () => {
    it('maps a file under addons/ to its module, not to "addons"', () => {
      expect(changedModules(['addons/vania_sales/models/sale_order.py'])).toEqual([
        'vania_sales',
      ]);
    });

    it('collects several modules under addons/', () => {
      expect(
        changedModules([
          'addons/mod_a/models/x.py',
          'addons/mod_b/views/y.xml',
          'addons/mod_a/__manifest__.py',
        ]),
      ).toEqual(['mod_a', 'mod_b']);
    });

    it('ignores a file directly inside addons/, which belongs to no module', () => {
      expect(changedModules(['addons/.gitkeep', 'addons/README.md'])).toEqual([]);
    });

    it('still handles a repository whose modules sit at the root', () => {
      expect(changedModules(['mod_a/models/x.py'])).toEqual(['mod_a']);
    });

    it('tolerates a leading ./ before addons/', () => {
      expect(changedModules(['./addons/mod_a/models/x.py'])).toEqual(['mod_a']);
    });

    /** A module legitimately called "addons" at the root is not the layout. */
    it('does not strip a second addons segment', () => {
      expect(changedModules(['addons/addons/models/x.py'])).toEqual(['addons']);
    });
  });
});
