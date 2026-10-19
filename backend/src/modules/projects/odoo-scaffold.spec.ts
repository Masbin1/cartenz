import {
  deriveDirectoryName,
  isValidDirectoryName,
  buildScaffoldFiles,
} from './odoo-scaffold';

/**
 * ADR-032 as amended by ADR-033. The name is the project directory, the
 * PostgreSQL database and the instance's subdomain
 * (`<name>.<PROJECT_BASE_DOMAIN>`), so the derivation is a constraint rather
 * than a formatting preference.
 */
describe('deriveDirectoryName', () => {
  it('lowercases and joins words with hyphens', () => {
    expect(deriveDirectoryName('PT Angin Ribut')).toBe('pt-angin-ribut');
    expect(deriveDirectoryName('Vania Sales')).toBe('vania-sales');
  });

  it('turns a plain project name into the subdomain the portal advertises', () => {
    expect(deriveDirectoryName('Toko Roti Budi')).toBe('toko-roti-budi');
  });

  it('collapses every other character into a single hyphen', () => {
    expect(deriveDirectoryName('Sales — Incentive (2026)')).toBe('sales-incentive-2026');
    expect(deriveDirectoryName('a//b__c')).toBe('a-b-c');
    expect(deriveDirectoryName('Toko & Roti, Budi!')).toBe('toko-roti-budi');
  });

  it('strips accents instead of dropping the letter', () => {
    expect(deriveDirectoryName('Café Manager')).toBe('cafe-manager');
  });

  it('keeps a leading digit, which is valid in a hostname and a database name', () => {
    expect(deriveDirectoryName('2026 Roadmap')).toBe('2026-roadmap');
  });

  it('returns null when nothing usable survives', () => {
    expect(deriveDirectoryName('!!!')).toBeNull();
    expect(deriveDirectoryName('   ')).toBeNull();
  });

  it('bounds the length to what the provisioning scripts accept', () => {
    const name = deriveDirectoryName('word '.repeat(40));
    expect(name!.length).toBeLessThanOrEqual(31);
    expect(name!.endsWith('-')).toBe(false);
  });
});

describe('isValidDirectoryName', () => {
  it('accepts a lowercase identifier, with hyphens or underscores', () => {
    expect(isValidDirectoryName('pt_angin_ribut')).toBe(true);
    expect(isValidDirectoryName('pt-angin-ribut')).toBe(true);
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

  it('refuses names the hostname or the scripts would not accept', () => {
    expect(isValidDirectoryName('Vania')).toBe(false); // uppercase
    expect(isValidDirectoryName('_leading')).toBe(false);
    expect(isValidDirectoryName('trailing_')).toBe(false);
    expect(isValidDirectoryName('trailing-')).toBe(false); // invalid hostname label
    expect(isValidDirectoryName('-leading')).toBe(false);
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

/**
 * ADR-035: a scaffolded project runs as a local Odoo dev server without Docker.
 * The two extra files appear only when the base path holds an odoo-bin, so an
 * environment-only deployment keeps the three ADR-032 files unchanged.
 */
describe('buildScaffoldFiles with a runnable config', () => {
  const runnable = {
    directoryName: 'pt_angin_ribut',
    basePath: '/home/masbintang/linkederp/base/odoo',
    enterprisePath: '/home/masbintang/linkederp/base/enterprise',
    edition: 'enterprise' as const,
    python: '/home/masbintang/venv/bin/python',
    httpPort: 8069,
  };
  const files = buildScaffoldFiles({ projectName: 'PT Angin Ribut', runnable });
  const byPath = (path: string) => files.find((file) => file.path === path);

  it('adds a runnable odoo.conf and run.sh on top of the three base files', () => {
    expect(files.map((file) => file.path).sort()).toEqual([
      '.gitignore',
      'README.md',
      'addons/.gitkeep',
      'odoo.conf',
      'run.sh',
    ]);
  });

  it('lists project, enterprise then core on the addons path', () => {
    const conf = byPath('odoo.conf')!.content;
    expect(conf).toContain(
      'addons_path = /home/masbintang/linkederp/base/odoo/addons,' +
        '/home/masbintang/linkederp/base/enterprise,addons',
    );
    expect(conf).toContain('db_name = pt_angin_ribut');
    expect(conf).toContain('http_port = 8069');
  });

  it('keeps no password in the committed conf', () => {
    expect(byPath('odoo.conf')!.content).not.toContain('db_password');
  });

  it('makes run.sh executable and names the interpreter and odoo-bin', () => {
    const run = byPath('run.sh')!;
    expect(run.mode).toBe(0o755);
    expect(run.content).toContain("'/home/masbintang/venv/bin/python'");
    expect(run.content).toContain("'/home/masbintang/linkederp/base/odoo/odoo-bin'");
    expect(run.content).toContain('-c odoo.conf "$@"');
    expect(run.content).toContain('PGPASSWORD');
  });

  it('omits the enterprise entry when it is not configured', () => {
    const [, conf] = [
      null,
      buildScaffoldFiles({
        projectName: 'X',
        runnable: { ...runnable, enterprisePath: null },
      }).find((file) => file.path === 'odoo.conf')!.content,
    ];
    expect(conf).toContain('addons_path = /home/masbintang/linkederp/base/odoo/addons,addons');
  });

  it('adds nothing runnable when no runnable config is given', () => {
    const plain = buildScaffoldFiles({ projectName: 'X' });
    expect(plain.map((file) => file.path)).not.toContain('odoo.conf');
    expect(plain.map((file) => file.path)).not.toContain('run.sh');
    expect(plain).toHaveLength(3);
  });

  /**
   * ADR-037: a Community project has no enterprise licence, so its conf must not
   * load the enterprise addons even when an enterprise path is configured.
   */
  it('omits the enterprise path for a community project', () => {
    const conf = buildScaffoldFiles({
      projectName: 'X',
      runnable: { ...runnable, edition: 'community' },
    }).find((file) => file.path === 'odoo.conf')!.content;
    expect(conf).toContain('addons_path = /home/masbintang/linkederp/base/odoo/addons,addons');
    expect(conf).not.toContain('/base/enterprise');
  });

  it('keeps the enterprise path for an enterprise project', () => {
    const conf = buildScaffoldFiles({
      projectName: 'X',
      runnable: { ...runnable, edition: 'enterprise' },
    }).find((file) => file.path === 'odoo.conf')!.content;
    expect(conf).toContain('/home/masbintang/linkederp/base/enterprise');
  });
});
