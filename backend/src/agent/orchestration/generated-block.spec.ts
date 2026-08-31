import { generatedFileTemplate, insertGeneratedBlock } from './generated-block';

/**
 * The scripted provider writes real files, so what it produces has to be valid.
 *
 * The XML case is the reason this file exists: appending a block after the closing
 * root element produced a document with two roots, which Odoo refuses to load. It
 * was found in verification, and it is the kind of defect a unit test catches and
 * a smoke test does not.
 */
describe('generated block', () => {
  const xmlDocument = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<odoo>',
    '    <record id="view_order_form" model="ir.ui.view">',
    '        <field name="model">sale.order</field>',
    '    </record>',
    '</odoo>',
    '',
  ].join('\n');

  const pythonModule = [
    'from odoo import fields, models',
    '',
    '',
    'class SaleOrder(models.Model):',
    "    _inherit = 'sale.order'",
    '',
  ].join('\n');

  describe('insertGeneratedBlock', () => {
    it('inserts an XML block before the closing root, not after it', () => {
      const content = insertGeneratedBlock(xmlDocument, 'views/x.xml', 'Add a field');

      expect(content.trimEnd().endsWith('</odoo>')).toBe(true);
      expect(content.indexOf('LinkedERP AI: begin')).toBeLessThan(content.lastIndexOf('</odoo>'));
      // Exactly one root element.
      expect(content.split('<odoo>')).toHaveLength(2);
      expect(content.split('</odoo>')).toHaveLength(2);
    });

    it('appends a Python block at the end and keeps the original', () => {
      const content = insertGeneratedBlock(pythonModule, 'models/x.py', 'Add a field');

      expect(content.startsWith('from odoo import')).toBe(true);
      expect(content).toContain('class SaleOrder(models.Model):');
      expect(content).toContain('# --- LinkedERP AI: begin generated block ---');
    });

    it('replaces its own previous block instead of adding a second', () => {
      const once = insertGeneratedBlock(pythonModule, 'models/x.py', 'First change');
      const twice = insertGeneratedBlock(once, 'models/x.py', 'Second change');

      expect(twice.split('LinkedERP AI: begin generated block')).toHaveLength(2);
      expect(twice).toContain('Second change');
      expect(twice).not.toContain('First change');
    });

    it('never leaves an unclosed marker', () => {
      for (const [source, path] of [
        [pythonModule, 'models/x.py'],
        [xmlDocument, 'views/x.xml'],
      ] as const) {
        const content = insertGeneratedBlock(source, path, 'Add a field');
        const begins = content.split('begin generated block').length - 1;
        const ends = content.split('end generated block').length - 1;

        expect(begins).toBe(1);
        expect(ends).toBe(1);
      }
    });

    it('appends rather than dropping the block when XML has no closing tag', () => {
      // A visibly odd file is better than a lost change.
      const content = insertGeneratedBlock('<odoo>', 'views/x.xml', 'Add a field');
      expect(content).toContain('LinkedERP AI: begin generated block');
    });

    it('collapses a double hyphen, which XML forbids inside a comment', () => {
      // A summary containing "--" would produce a comment no XML parser accepts,
      // and Odoo would refuse to load the file.
      const content = insertGeneratedBlock(xmlDocument, 'views/x.xml', 'Fix the -- separator');

      expect(content).not.toContain('Fix the -- separator');
      expect(content).toContain('Fix the - separator');
    });
  });

  describe('generatedFileTemplate', () => {
    it('creates a valid XML document', () => {
      const content = generatedFileTemplate('views/x.xml', 'Add a field');

      expect(content.startsWith('<?xml version="1.0"')).toBe(true);
      expect(content).toContain('<odoo>');
      expect(content.trimEnd().endsWith('</odoo>')).toBe(true);
    });

    it('creates an importable Python module', () => {
      const content = generatedFileTemplate('models/x.py', 'Add a field');
      expect(content).toContain('from odoo import');
    });
  });
});
