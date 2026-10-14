import { catalogueForPrompt, keepCatalogued } from './odoo-module-recommendation';

const entry = (technicalName: string, isApplication = true) => ({
  technicalName,
  name: technicalName,
  category: null,
  isApplication,
  depends: [],
});

describe('module recommendation', () => {
  const catalogue = [entry('stock'), entry('hr'), entry('stock_account', false)];

  it('keeps only catalogued names, once each, in the model order', () => {
    const result = keepCatalogued(
      [
        { technicalName: 'hr', reason: 'Employees' },
        { technicalName: 'equipment_magic', reason: 'Invented' },
        { technicalName: 'stock', reason: 'Assets' },
        { technicalName: 'hr', reason: 'Repeated' },
      ],
      catalogue,
    );
    expect(result.map((item) => item.technicalName)).toEqual(['hr', 'stock']);
  });

  it('offers the model applications only', () => {
    expect(catalogueForPrompt(catalogue)).toBe('stock: stock\nhr: hr');
  });
});
