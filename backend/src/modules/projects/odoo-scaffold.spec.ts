import {
  deriveDirectoryName,
  isValidDirectoryName,
  buildScaffoldFiles,
} from './odoo-scaffold';

/**
 * ADR-032 as amended by ADR-033. The directory sits on an Odoo addons path and
 * its children are Python packages, so the derivation is a constraint rather
 * than a formatting preference.
 */
describe('deriveDirectoryName', () => {
  it('lowercases and joins words with underscores', () => {
    expect(deriveDirectoryName('PT Angin Ribut')).toBe('pt_angin_ribut');
    expect(deriveDirectoryName('Vania Sales')).toBe('vania_sales');
  });

  it('collapses punctuation rather than carrying it into a path', () => {
    expect(deriveDirectoryName('Sales — Incentive (2026)')).toBe('sales_incentive_2026');
    expect(deriveDirectoryName('a//b__c')).toBe('a_b_c');
  });

  it('strips accents instead of dropping the letter', () => {
    expect(deriveDirectoryName('Café Manager')).toBe('cafe_manager');
  });

  it('prefixes a leading digit, which cannot start an identifier', () => {
    expect(deriveDirectoryName('2026 Roadmap')).toBe('m_2026_roadmap');
  });

  it('returns null when nothing usable survives', () => {
    expect(deriveDirectoryName('!!!')).toBeNull();
    expect(deriveDirectoryName('   ')).toBeNull();
  });

  it('bounds the length', () => {
    const name = deriveDirectoryName('word '.repeat(40));
    expect(name!.length).toBeLessThanOrEqual(63);
    expect(name!.endsWith('_')).toBe(false);
  });
});

describe('isValidDirectoryName', () => {
  it('accepts a lowercase identifier', () => {
    expect(isValidDirectoryName('pt_angin_ribut')).toBe(true);
    expect(isValidDirectoryName('a1')).toBe(true);
  });

  /**
   * The name is joined onto the projects root to make a directory, so anything
   * that could traverse or escape is refused here as well as by the containment
   * check in the service.
   */
  it('refuses anything that could leave the intended directory', () => {
    expect(isValidDirectoryName('../escape')).toBe(false);
    expect(isValidDirectoryName('a/b')).toBe(false);
    expect(isValidDirectoryName('a\\b')).toBe(false);
    expect(isValidDirectoryName('/absolute')).toBe(false);
    expect(isValidDirectoryName('.hidden')).toBe(false);
    expect(isValidDirectoryName('..')).toBe(false);
  });

  it('refuses names Odoo or Python would not accept', () => {
    expect(isValidDirectoryName('Vania')).toBe(false); // uppercase
    expect(isValidDirectoryName('1abc')).toBe(false); // leading digit
    expect(isValidDirectoryName('_leading')).toBe(false);
    expect(isValidDirectoryName('trailing_')).toBe(false);
    expect(isValidDirectoryName('with-dash')).toBe(false);
    expect(isValidDirectoryName('')).toBe(false);
    expect(isValidDirectoryName('a'.repeat(64))).toBe(false);
  });
});

describe('buildScaffoldFiles', () => {
  const files = buildScaffoldFiles({ projectName: 'PT Angin Ribut' });
  const paths = files.map((file) => file.path);

  /**
   * The whole point of the layout: a writable addons directory separate from the
   * read-only Odoo source, so base and enterprise cannot be edited (ADR-033).
   */
  it('creates an addons directory and nothing else of substance', () => {
    expect(paths).toContain('addons/.gitkeep');
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('README.md');
    expect(paths).toHaveLength(3);
  });

  /**
   * Git does not track directories: without the marker the addons directory
   * would exist for whoever created it and vanish for anyone who cloned.
   */
  it('marks the empty directory so it survives a clone', () => {
    expect(files.find((file) => file.path === 'addons/.gitkeep')!.content).toBe('');
  });

  /**
   * A module scaffolded before anyone has described the work carries a name and
   * a manifest the first real task usually has to rewrite.
   */
  it('ships no module: no manifest, no package markers, no access rules', () => {
    expect(paths.some((path) => path.includes('__manifest__.py'))).toBe(false);
    expect(paths.some((path) => path.includes('__init__.py'))).toBe(false);
    expect(paths.some((path) => path.includes('ir.model.access.csv'))).toBe(false);
    expect(paths.some((path) => path.includes('models/'))).toBe(false);
  });

  it('ignores Python build artefacts', () => {
    expect(files.find((file) => file.path === '.gitignore')!.content).toContain('__pycache__');
  });

  it('names the project in the README and says where work goes', () => {
    const readme = files.find((file) => file.path === 'README.md')!.content;
    expect(readme).toContain('# PT Angin Ribut');
    expect(readme).toContain('addons/');
    expect(readme).toContain('read-only');
  });
});
