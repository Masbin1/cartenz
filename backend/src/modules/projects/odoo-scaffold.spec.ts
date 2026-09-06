import { deriveTechnicalName, isValidTechnicalName, buildScaffoldFiles } from './odoo-scaffold';

/**
 * ADR-032. An Odoo module name is a Python package name and a directory name, so
 * the derivation is a constraint rather than a formatting preference.
 */
describe('deriveTechnicalName', () => {
  it('lowercases and joins words with underscores', () => {
    expect(deriveTechnicalName('Vania Sales')).toBe('vania_sales');
    expect(deriveTechnicalName('VIF Sales Incentive')).toBe('vif_sales_incentive');
  });

  it('collapses punctuation rather than carrying it into a package name', () => {
    expect(deriveTechnicalName('Sales — Incentive (2026)')).toBe('sales_incentive_2026');
    expect(deriveTechnicalName('a//b__c')).toBe('a_b_c');
  });

  it('strips accents instead of dropping the letter', () => {
    expect(deriveTechnicalName('Café Manager')).toBe('cafe_manager');
  });

  it('prefixes a leading digit, which cannot start an identifier', () => {
    expect(deriveTechnicalName('2026 Roadmap')).toBe('m_2026_roadmap');
  });

  it('returns null when nothing usable survives', () => {
    expect(deriveTechnicalName('!!!')).toBeNull();
    expect(deriveTechnicalName('   ')).toBeNull();
  });

  it('bounds the length', () => {
    const name = deriveTechnicalName('word '.repeat(40));
    expect(name!.length).toBeLessThanOrEqual(63);
    expect(name!.endsWith('_')).toBe(false);
  });
});

describe('isValidTechnicalName', () => {
  it('accepts a lowercase identifier', () => {
    expect(isValidTechnicalName('vania_sales')).toBe(true);
    expect(isValidTechnicalName('a1')).toBe(true);
  });

  /**
   * The name is joined onto the on-premise root to make a directory, so anything
   * that could traverse or escape is refused here as well as by the containment
   * check in the service.
   */
  it('refuses anything that could leave the intended directory', () => {
    expect(isValidTechnicalName('../escape')).toBe(false);
    expect(isValidTechnicalName('a/b')).toBe(false);
    expect(isValidTechnicalName('a\\b')).toBe(false);
    expect(isValidTechnicalName('/absolute')).toBe(false);
    expect(isValidTechnicalName('.hidden')).toBe(false);
    expect(isValidTechnicalName('..')).toBe(false);
  });

  it('refuses names Odoo or Python would not accept', () => {
    expect(isValidTechnicalName('Vania')).toBe(false); // uppercase
    expect(isValidTechnicalName('1abc')).toBe(false); // leading digit
    expect(isValidTechnicalName('_leading')).toBe(false);
    expect(isValidTechnicalName('trailing_')).toBe(false);
    expect(isValidTechnicalName('with-dash')).toBe(false);
    expect(isValidTechnicalName('')).toBe(false);
    expect(isValidTechnicalName('a'.repeat(64))).toBe(false);
  });
});

describe('buildScaffoldFiles', () => {
  const files = buildScaffoldFiles({
    technicalName: 'vania_sales',
    projectName: 'Vania Sales',
    odooVersion: '19.0',
  });
  const find = (path: string) => files.find((file) => file.path === path);

  it('produces a loadable module: package markers, manifest, access rules', () => {
    expect(find('vania_sales/__init__.py')?.content).toContain('from . import models');
    expect(find('vania_sales/models/__init__.py')).toBeDefined();
    expect(find('vania_sales/__manifest__.py')).toBeDefined();
    expect(find('vania_sales/security/ir.model.access.csv')?.content).toContain('perm_unlink');
    expect(find('.gitignore')?.content).toContain('__pycache__');
  });

  it('writes a manifest carrying the project name and the Odoo series', () => {
    const manifest = find('vania_sales/__manifest__.py')!.content;
    expect(manifest).toContain('"name": "Vania Sales"');
    expect(manifest).toContain('"version": "19.0.1.0.0"');
    expect(manifest).toContain('"installable": True');
    expect(manifest).toContain('"security/ir.model.access.csv"');
  });

  it('uses Python comment syntax in the manifest', () => {
    const manifest = find('vania_sales/__manifest__.py')!.content;
    expect(manifest).not.toContain('//');
    expect(manifest).toContain('# base only');
  });

  /**
   * A scaffold that ships a demo model produces modules that carry example code
   * for the rest of their life, and `depends` is a decision about work that has
   * not been described yet.
   */
  it('declares base only and ships no example model', () => {
    const manifest = find('vania_sales/__manifest__.py')!.content;
    expect(manifest).toContain('"depends": ["base"]');
    expect(manifest).not.toContain('"sale"');
    expect(files.some((file) => file.path.endsWith('models/sale_order.py'))).toBe(false);
  });

  it('falls back to a neutral version when the series is unknown', () => {
    const [, manifest] = buildScaffoldFiles({
      technicalName: 'x',
      projectName: 'X',
      odooVersion: null,
    });
    expect(manifest.content).toContain('"version": "1.0.1.0.0"');
  });
});
