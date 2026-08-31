import { AiBoundaryService } from './ai-boundary.service';
import { AiBoundaryRefusalError, REDACTIONS } from './boundary-types';

/**
 * The AI data boundary is the control that decides what leaves the platform
 * (chapter 12, ADR-020). These tests are the substance of that guarantee, so they
 * are written the same way the Phase 2 security tests were: what matters is what
 * is refused and removed, not what is allowed through.
 *
 * The false-positive cases matter as much as the true positives. A boundary that
 * refuses ordinary Odoo source is a boundary that gets turned off.
 */
describe('AiBoundaryService', () => {
  const boundary = new AiBoundaryService();
  const outbound = { direction: 'to_provider' as const, label: 'test material' };

  describe('secrets are removed', () => {
    it.each([
      ['anthropic key', `API_KEY = "${['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz012345'].join('-')}"`],
      ['openai key', `key = "${['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')}"`],
      ['github token', `token = "${['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')}"`],
      ['github fine-grained token', ['github', 'pat', '11ABCDEFG0abcdefghijklmnop'].join('_')],
      ['gitlab token', ['glpat', 'abcdefghijklmnopqrst'].join('-')],
      ['aws access key', ['AKIA', 'IOSFODNN7EXAMPLE'].join('')],
      ['google api key', ['AIza', 'SyA-abcdefghijklmnopqrstuvwxyz01234567'].join('')],
      ['slack token', ['xox', 'b-123456789012-abcdefghijklmnopqrstuvwx'].join('')],
      ['stripe key', ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_')],
    ])('removes an %s', (_label, material) => {
      const result = boundary.filter(material, outbound);

      expect(result.allowed).toBe(true);
      expect(result.content).toContain(REDACTIONS.secret);
      expect(result.redactionCount).toBeGreaterThan(0);
      // The value itself must be gone, not merely flagged.
      const secret = material.match(/[A-Za-z0-9_-]{16,}/g)?.pop();
      if (secret) expect(result.content).not.toContain(secret);
    });

    it('removes a PEM private key block however long', () => {
      const key = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn'.repeat(20),
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');

      const result = boundary.filter(`deploy_key = """${key}"""`, outbound);
      expect(result.content).not.toContain('MIIEpAIBAAKCAQEA');
      expect(result.content).toContain(REDACTIONS.secret);
    });

    it('removes a password from a connection string but keeps the host', () => {
      const result = boundary.filter(
        'db_url = "postgresql://odoo:s3cr3tp4ssw0rd@db.internal:5432/production"',
        outbound,
      );

      expect(result.content).not.toContain('s3cr3tp4ssw0rd');
      // The host is technical context the model can legitimately use.
      expect(result.content).toContain('db.internal:5432/production');
    });

    it('removes an assigned secret that has no recognisable format', () => {
      // The case a format-based scanner would miss entirely: an Odoo master
      // password is just a string.
      const result = boundary.filter('admin_passwd = "correct horse battery"', outbound);

      expect(result.content).not.toContain('correct horse battery');
      expect(result.content).toContain('admin_passwd');
      expect(result.findings.some((finding) => finding.rule === 'assigned_secret')).toBe(true);
    });

    it('refuses material whose credential density makes it a secrets file', () => {
      const dotEnv = Array.from(
        { length: 12 },
        (_, index) => `SERVICE_${index}_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz012345${index}"`,
      ).join('\n');

      // Redacting this would still send its structure and variable names.
      expect(() => boundary.filterOrThrow(dotEnv, outbound)).toThrow(AiBoundaryRefusalError);
      expect(boundary.filter(dotEnv, outbound).allowed).toBe(false);
    });
  });

  describe('personal information is removed but source survives', () => {
    it('removes a personal email address', () => {
      const result = boundary.filter('contact = "thandi.mokoena@acme-manufacturing.co.za"', outbound);
      expect(result.content).not.toContain('thandi.mokoena');
      expect(result.content).toContain(REDACTIONS.pii);
    });

    it('keeps an example or maintainer address, which is not personal data', () => {
      // An Odoo manifest names its author. Redacting it removes useful context
      // for nothing.
      const material = "'author': 'LinkedERP', 'support': 'support@linkederp.com', 'x': 'a@example.com'";
      const result = boundary.filter(material, outbound);

      expect(result.content).toContain('support@linkederp.com');
      expect(result.content).toContain('a@example.com');
    });

    it('removes a payment card number that passes Luhn', () => {
      const result = boundary.filter('card = "4111 1111 1111 1111"', outbound);
      expect(result.content).not.toContain('4111 1111 1111 1111');
    });

    it('leaves a sixteen-digit number that is not a card number', () => {
      // Far more often an identifier, a timestamp or a hash prefix than a card,
      // which is why the Luhn check is there.
      const result = boundary.filter('reference = "1234567890123456"', outbound);
      expect(result.content).toContain('1234567890123456');
    });

    it('removes a South African identity number', () => {
      const result = boundary.filter('id_number = "8801015800085"', outbound);
      expect(result.content).not.toContain('8801015800085');
    });

    it('leaves a thirteen-digit number whose date is impossible', () => {
      // Month 99 is not a birth date, so this is an ordinary identifier.
      const result = boundary.filter('seq = "1199015800085"', outbound);
      expect(result.content).toContain('1199015800085');
    });

    it('leaves ordinary Odoo source untouched', () => {
      const source = [
        'from odoo import api, fields, models',
        '',
        '',
        'class SaleOrder(models.Model):',
        "    _inherit = 'sale.order'",
        '',
        '    customer_reference = fields.Char(',
        "        string='Customer Reference',",
        "        help='The reference the customer uses for this order.',",
        '        index=True,',
        '    )',
        '',
        '    @api.depends(\'order_line.price_subtotal\')',
        '    def _compute_total(self):',
        '        for order in self:',
        "            order.total = sum(order.order_line.mapped('price_subtotal'))",
      ].join('\n');

      const result = boundary.filter(source, outbound);

      expect(result.allowed).toBe(true);
      expect(result.redactionCount).toBe(0);
      expect(result.content).toBe(source);
    });
  });

  describe('customer data is refused, not redacted', () => {
    it('refuses a pg_dump', () => {
      const dump = [
        '--',
        '-- PostgreSQL database dump',
        '--',
        'COPY public.res_partner (id, name, email, phone) FROM stdin;',
        '1\tAcme\tinfo@acme.test\t011 555 1234',
        String.fromCharCode(92) + '.',
      ].join('\n');

      const result = boundary.filter(dump, outbound);
      expect(result.allowed).toBe(false);
      expect(result.refusalReason).toContain('database or record content');
      // Nothing is returned: a redacted dump is still a dump.
      expect(result.content).toBe('');
    });

    it('refuses a batch of INSERT statements', () => {
      const inserts = Array.from(
        { length: 6 },
        (_, index) =>
          `INSERT INTO res_partner (name, email) VALUES ('Customer ${index}', 'c${index}@acme.test');`,
      ).join('\n');

      expect(boundary.filter(inserts, outbound).allowed).toBe(false);
    });

    it('refuses a CSV of customer records', () => {
      const csv = [
        'first_name,last_name,email,phone,vat',
        'Thandi,Mokoena,t.mokoena@acme.test,011 555 0001,4123456789',
        'Sipho,Ndlovu,s.ndlovu@acme.test,011 555 0002,4123456790',
        'Anna,Botha,a.botha@acme.test,011 555 0003,4123456791',
        'Johan,Smit,j.smit@acme.test,011 555 0004,4123456792',
        'Lerato,Dube,l.dube@acme.test,011 555 0005,4123456793',
      ].join('\n');

      const result = boundary.filter(csv, outbound);
      expect(result.allowed).toBe(false);
      expect(result.findings.some((finding) => finding.rule === 'delimited_record_set')).toBe(true);
    });

    it('refuses a JSON array of customer records', () => {
      const records = JSON.stringify(
        Array.from({ length: 6 }, (_, index) => ({
          id: index,
          first_name: `Customer ${index}`,
          email: `c${index}@acme.test`,
          phone: `011 555 000${index}`,
        })),
      );

      const result = boundary.filter(records, outbound);
      expect(result.allowed).toBe(false);
      expect(result.findings.some((finding) => finding.rule === 'json_record_array')).toBe(true);
    });

    it('does not refuse a CSV that is Odoo access rules', () => {
      // The file every Odoo module has. Refusing it would break the platform on
      // essentially every real repository.
      const accessRules = [
        'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink',
        'access_sale_order,sale.order,sale.model_sale_order,base.group_user,1,1,0,0',
        'access_sale_line,sale.order.line,sale.model_sale_order_line,base.group_user,1,1,0,0',
        'access_partner,res.partner,base.model_res_partner,base.group_user,1,0,0,0',
        'access_product,product.template,product.model_product_template,base.group_user,1,1,1,0',
        'access_invoice,account.move,account.model_account_move,base.group_user,1,1,0,0',
      ].join('\n');

      const result = boundary.filter(accessRules, outbound);
      expect(result.allowed).toBe(true);
    });

    it('does not refuse a short code sample containing a record-shaped literal', () => {
      // One dict with an email field is a test fixture, not a data set.
      const source = [
        'def test_partner_creation(self):',
        '    partner = self.env["res.partner"].create({',
        '        "name": "Test Partner",',
        '        "email": "test@example.com",',
        '    })',
        '    self.assertTrue(partner.id)',
      ].join('\n');

      expect(boundary.filter(source, outbound).allowed).toBe(true);
    });
  });

  describe('both directions are filtered', () => {
    it('filters what comes back from the provider', () => {
      // A model that has read a credential can repeat it, and its output reaches
      // the action log, the event stream and a browser.
      const modelOutput =
        'I found the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in settings.py and used it.';

      const result = boundary.filter(modelOutput, {
        direction: 'from_provider',
        label: 'model summary',
      });

      expect(result.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
      expect(result.redactionCount).toBeGreaterThan(0);
    });
  });

  describe('reporting', () => {
    it('counts findings and bytes removed, so heavy filtering is visible', () => {
      const material = [
        'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
        'contact = "person@customer.co.za"',
      ].join('\n');

      const result = boundary.filter(material, outbound);

      expect(result.redactionCount).toBe(2);
      expect(result.findings.map((finding) => finding.kind).sort()).toEqual(['pii', 'secret']);
    });

    it('never carries the matched text in a finding', () => {
      const result = boundary.filter('token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', outbound);

      // A finding that quoted what it found would put the secret in the audit
      // trail, which is the thing being prevented.
      const serialised = JSON.stringify(result.findings);
      expect(serialised).not.toContain('ghp_');
    });

    it('handles empty and whitespace-only material without failing', () => {
      for (const material of ['', '   ', '\n\n']) {
        const result = boundary.filter(material, outbound);
        expect(result.allowed).toBe(true);
        expect(result.redactionCount).toBe(0);
      }
    });
  });

  describe('filterParts', () => {
    it('names the offending part when it refuses', () => {
      const dump = [
        '-- PostgreSQL database dump',
        'COPY public.res_partner (id, name) FROM stdin;',
      ].join('\n');

      // "The prompt was refused" is not actionable; the part's label is.
      expect(() =>
        boundary.filterParts(
          [
            { label: 'Development request', content: 'Add a field' },
            { label: 'File: data/export.sql', content: dump },
          ],
          'to_provider',
        ),
      ).toThrow(/data[/]export[.]sql/);
    });

    it('combines findings across parts', () => {
      const { parts, summary } = boundary.filterParts(
        [
          { label: 'a', content: 'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"' },
          { label: 'b', content: 'token = "ghp_zyxwvutsrqponmlkjihgfedcba9876543210"' },
        ],
        'to_provider',
      );

      expect(parts).toHaveLength(2);
      expect(summary.redactionCount).toBe(2);
      // Merged into one finding of two occurrences rather than two findings.
      expect(summary.findings).toHaveLength(1);
      expect(summary.findings[0].occurrences).toBe(2);
    });
  });
});
