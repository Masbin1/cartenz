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
});
