import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchCode } from './code-search';
import { walkRepository } from './repository-walker';

/**
 * Built on a real tree, because the properties worth testing are filesystem
 * properties: that ignored directories are skipped, that symbolic links are not
 * followed, and that the caps actually bound the result.
 */
describe('code search and repository walk', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'linkederp-search-'));

    await mkdir(join(root, 'models'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'junk'), { recursive: true });
    await mkdir(join(root, '.git', 'objects'), { recursive: true });
    await mkdir(join(root, '__pycache__'), { recursive: true });

    await writeFile(
      join(root, 'models', 'sale_order.py'),
      ['from odoo import fields, models', '', '', 'class SaleOrder(models.Model):', "    _inherit = 'sale.order'", ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'views', 'sale_order_views.xml'),
      ['<odoo>', '  <record id="view_order_form" model="ir.ui.view">', '    <field name="model">sale.order</field>', '  </record>', '</odoo>'].join('\n'),
      'utf8',
    );
    await writeFile(join(root, 'node_modules', 'junk', 'index.js'), "// sale.order\n", 'utf8');
    await writeFile(join(root, '.git', 'objects', 'blob'), 'sale.order\n', 'utf8');
    await writeFile(join(root, '__pycache__', 'cached.py'), 'sale.order\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('searchCode', () => {
    it('finds matches in Python and XML source', async () => {
      const result = await searchCode(root, 'sale.order');

      const paths = result.matches.map((match) => match.path).sort();
      expect(paths).toContain('models/sale_order.py');
      expect(paths).toContain('views/sale_order_views.xml');
    });

    it('reports the line number and a trimmed preview', async () => {
      const result = await searchCode(root, '_inherit');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].line).toBe(5);
      expect(result.matches[0].preview).toBe("_inherit = 'sale.order'");
    });

    it('is case insensitive', async () => {
      const result = await searchCode(root, 'SALEORDER');
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('skips .git, node_modules and __pycache__', async () => {
      const result = await searchCode(root, 'sale.order');
      const paths = result.matches.map((match) => match.path);

      for (const ignored of ['node_modules', '.git', '__pycache__']) {
        expect(paths.some((path) => path.includes(ignored))).toBe(false);
      }
    });

    it('returns nothing for a query below the minimum length', async () => {
      // A one-character search matches most of a repository and returns noise.
      expect((await searchCode(root, 'a')).matches).toHaveLength(0);
      expect((await searchCode(root, '')).matches).toHaveLength(0);
    });

    it('bounds the number of results and reports the truncation', async () => {
      await mkdir(join(root, 'many'), { recursive: true });
      for (let index = 0; index < 40; index += 1) {
        await writeFile(join(root, 'many', `file_${index}.py`), 'needle\n', 'utf8');
      }

      const result = await searchCode(root, 'needle', { maxResults: 10 });
      expect(result.matches).toHaveLength(10);
      expect(result.truncated).toBe(true);
    });

    /**
     * A literal search cannot be made to backtrack catastrophically. This asserts
     * that a pattern which would hang a regular-expression engine is treated as
     * text and returns promptly.
     */
    it('treats a pathological regular expression as a literal string', async () => {
      await writeFile(join(root, 'models', 'long.py'), `${'a'.repeat(20000)}\n`, 'utf8');

      const startedAt = Date.now();
      const result = await searchCode(root, '(a+)+$');

      expect(result.matches).toHaveLength(0);
      expect(Date.now() - startedAt).toBeLessThan(3000);
    });

    it('strips control characters from a preview', async () => {
      const bell = String.fromCharCode(7);
      await writeFile(join(root, 'models', 'weird.py'), `needle${bell}here\n`, 'utf8');

      const result = await searchCode(root, 'needle');
      const preview = result.matches.find((match) => match.path === 'models/weird.py')?.preview;
      expect(preview).toBe('needle here');
    });
  });

  describe('walkRepository', () => {
    it('does not follow symbolic links', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'linkederp-outside-'));
      await writeFile(join(outside, 'host.py'), 'secret\n', 'utf8');
      await symlink(outside, join(root, 'escape'));

      const result = await walkRepository(root);

      expect(result.files.some((file) => file.path.includes('escape/'))).toBe(false);
      expect(result.symlinksSkipped).toBeGreaterThan(0);

      await rm(outside, { recursive: true, force: true });
    });

    it('bounds the file count and reports the truncation', async () => {
      await mkdir(join(root, 'bulk'), { recursive: true });
      for (let index = 0; index < 30; index += 1) {
        await writeFile(join(root, 'bulk', `f${index}.py`), 'x\n', 'utf8');
      }

      const result = await walkRepository(root, { maxFiles: 5 });
      expect(result.files.length).toBeLessThanOrEqual(5);
      expect(result.truncated).toBe(true);
    });

    it('bounds the depth and reports the truncation', async () => {
      let deep = root;
      for (let index = 0; index < 8; index += 1) {
        deep = join(deep, `level${index}`);
      }
      await mkdir(deep, { recursive: true });
      await writeFile(join(deep, 'deep.py'), 'x\n', 'utf8');

      const result = await walkRepository(root, { maxDepth: 3 });
      expect(result.truncated).toBe(true);
      expect(result.files.some((file) => file.path.includes('level5'))).toBe(false);
    });

    it('filters by extension when asked', async () => {
      const result = await walkRepository(root, { extensions: new Set(['.xml']) });
      expect(result.files.every((file) => file.extension === '.xml')).toBe(true);
      expect(result.files.length).toBeGreaterThan(0);
    });

    it('returns forward-slash paths regardless of platform', async () => {
      const result = await walkRepository(root, { extensions: new Set(['.py']) });
      for (const file of result.files) {
        expect(file.path).not.toContain(String.fromCharCode(92));
      }
    });
  });
});
