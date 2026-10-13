import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryGroups,
  filterModules,
  topLevelCategory,
  type CatalogModule,
} from './module-catalog';

const mod = (overrides: Partial<CatalogModule> & { technicalName: string }): CatalogModule => ({
  name: overrides.technicalName,
  category: null,
  isApplication: false,
  depends: [],
  ...overrides,
});

test('topLevelCategory returns the leading segment of a hierarchical category', () => {
  assert.equal(topLevelCategory('Accounting/Accounting'), 'Accounting');
  assert.equal(topLevelCategory('Accounting/Localizations/Account Charts'), 'Accounting');
  assert.equal(topLevelCategory('Supply Chain/Inventory'), 'Supply Chain');
  assert.equal(topLevelCategory('Hidden'), 'Hidden');
  assert.equal(topLevelCategory(null), null);
  assert.equal(topLevelCategory('  '), null);
});

test('categoryGroups collapses subcategories into their top-level group', () => {
  const catalogue = [
    mod({ technicalName: 'account', category: 'Accounting/Accounting' }),
    mod({ technicalName: 'l10n_x', category: 'Accounting/Localizations/Account Charts' }),
    mod({ technicalName: 'spreadsheet_account', category: 'Accounting' }),
    mod({ technicalName: 'sale', category: 'Sales/Sales' }),
    mod({ technicalName: 'base', category: null }),
  ];

  assert.deepEqual(categoryGroups(catalogue), ['Accounting', 'Sales']);
});

test('choosing a category reaches modules filed under it and beneath it', () => {
  const catalogue = [
    mod({ technicalName: 'account', category: 'Accounting/Accounting', isApplication: true }),
    mod({
      technicalName: 'l10n_x',
      category: 'Accounting/Localizations/Account Charts',
      isApplication: true,
    }),
    mod({ technicalName: 'spreadsheet_account', category: 'Accounting', isApplication: true }),
    mod({ technicalName: 'sale', category: 'Sales/Sales', isApplication: true }),
  ];

  const accounting = filterModules(catalogue, { category: 'Accounting' });

  assert.deepEqual(
    accounting.map((entry) => entry.technicalName),
    ['account', 'l10n_x', 'spreadsheet_account'],
  );
});

test('the category filter is inclusive when the app is filed under a subcategory', () => {
  // The regression: `account` carries "Accounting/Accounting", so an exact match
  // against the "Accounting" group (which exists because a data-only module
  // carries the bare string) showed nothing.
  const catalogue = [
    mod({ technicalName: 'account', category: 'Accounting/Accounting', isApplication: true }),
  ];

  assert.equal(filterModules(catalogue, { category: 'Accounting' }).length, 1);
});

test('apps-only is the default and search narrows by display and technical name', () => {
  const catalogue = [
    mod({ technicalName: 'sale', name: 'Sales', category: 'Sales/Sales', isApplication: true }),
    mod({
      technicalName: 'sale_technical',
      name: 'Sales Bits',
      category: 'Sales/Sales',
      isApplication: false,
    }),
  ];

  assert.deepEqual(filterModules(catalogue, {}).map((entry) => entry.technicalName), ['sale']);
  assert.deepEqual(
    filterModules(catalogue, { appsOnly: false, search: 'bits' }).map(
      (entry) => entry.technicalName,
    ),
    ['sale_technical'],
  );
});
