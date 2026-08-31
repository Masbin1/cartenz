import { odooSeriesFromVersion, parseOdooManifest } from './manifest-parser';

/**
 * The property these tests defend is that a manifest is never executed: it is
 * parsed as text. So the interesting cases are the ones where text parsing could
 * go wrong - comments, docstrings, quoting styles - and the case where a manifest
 * contains something that would be dangerous if evaluated.
 */
describe('parseOdooManifest', () => {
  it('reads a conventional manifest', () => {
    const manifest = parseOdooManifest(
      'omnisurge_sale',
      [
        '{',
        "    'name': 'Omnisurge Sales',",
        "    'version': '18.0.1.2.0',",
        "    'category': 'Sales',",
        "    'license': 'LGPL-3',",
        "    'depends': ['base', 'sale', 'account'],",
        "    'installable': True,",
        "    'application': False,",
        '}',
      ].join('\n'),
    );

    expect(manifest.technicalName).toBe('omnisurge_sale');
    expect(manifest.name).toBe('Omnisurge Sales');
    expect(manifest.version).toBe('18.0.1.2.0');
    expect(manifest.depends).toEqual(['base', 'sale', 'account']);
    expect(manifest.installable).toBe(true);
    expect(manifest.applicationFlag).toBe(false);
  });

  it('accepts double quotes as well as single', () => {
    const manifest = parseOdooManifest('m', '{"name": "Double", "version": "17.0.1.0.0"}');
    expect(manifest.name).toBe('Double');
    expect(manifest.version).toBe('17.0.1.0.0');
  });

  it('ignores a commented-out key', () => {
    const manifest = parseOdooManifest(
      'm',
      ["{", "    # 'version': '15.0.1.0.0',", "    'version': '18.0.1.0.0',", "}"].join('\n'),
    );
    expect(manifest.version).toBe('18.0.1.0.0');
  });

  it('ignores keys inside a docstring', () => {
    const manifest = parseOdooManifest(
      'm',
      [
        '"""',
        "An example manifest: 'version': '9.0.1.0.0'",
        '"""',
        '{',
        "    'version': '18.0.1.0.0',",
        '}',
      ].join('\n'),
    );
    expect(manifest.version).toBe('18.0.1.0.0');
  });

  it('does not evaluate the file, whatever it contains', () => {
    // If this were executed, it would attempt a subprocess. Parsing it returns
    // fields and nothing happens.
    const manifest = parseOdooManifest(
      'hostile',
      [
        'import os',
        'os.system("touch /tmp/linkederp-should-not-exist")',
        '{',
        "    'name': 'Hostile',",
        "    'version': '18.0.1.0.0',",
        "    'depends': ['base'],",
        '}',
      ].join('\n'),
    );

    expect(manifest.name).toBe('Hostile');
    expect(manifest.depends).toEqual(['base']);
  });

  it('reports missing fields as null rather than guessing', () => {
    const manifest = parseOdooManifest('m', '{}');
    expect(manifest.name).toBeNull();
    expect(manifest.version).toBeNull();
    expect(manifest.installable).toBeNull();
    expect(manifest.depends).toEqual([]);
  });

  it('reports keys it does not read, so an incomplete parse is visible', () => {
    const manifest = parseOdooManifest(
      'm',
      "{'name': 'X', 'data': ['views/x.xml'], 'assets': {}, 'external_dependencies': {}}",
    );
    expect(manifest.unparsedKeys).toContain('data');
    expect(manifest.unparsedKeys).toContain('assets');
    expect(manifest.unparsedKeys).not.toContain('name');
  });

  it('handles a manifest larger than the read limit without failing', () => {
    const padding = "    'summary': '".concat('x'.repeat(200000), "',");
    const manifest = parseOdooManifest('m', `{\n    'name': 'Big',\n${padding}\n}`);
    expect(manifest.name).toBe('Big');
  });
});

describe('odooSeriesFromVersion', () => {
  it('derives the series from a full module version', () => {
    expect(odooSeriesFromVersion('18.0.1.0.0')).toBe('18.0');
    expect(odooSeriesFromVersion('16.0.2.1.3')).toBe('16.0');
  });

  it('returns null for a module-only version, rather than misreading it', () => {
    // '1.0' is a module version, not Odoo 1.0.
    expect(odooSeriesFromVersion('1.0')).toBeNull();
    expect(odooSeriesFromVersion('2.3')).toBeNull();
  });

  it('returns null for an implausible or malformed version', () => {
    expect(odooSeriesFromVersion(null)).toBeNull();
    expect(odooSeriesFromVersion('')).toBeNull();
    expect(odooSeriesFromVersion('x.y.z')).toBeNull();
    expect(odooSeriesFromVersion('1.2.3')).toBeNull();
    expect(odooSeriesFromVersion('999.0.1.0.0')).toBeNull();
  });
});
