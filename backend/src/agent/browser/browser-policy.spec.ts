import { agentUrlRefusal, isAllowedUrl } from './browser-policy';

/**
 * The browser session's boundary (ADR-087, Option B): it stays on the project's
 * own Odoo Online host, and the agent is refused the identity, access and
 * technical screens even inside an approved session.
 */
describe('the in-portal browser policy', () => {
  const host = 'acme.odoo.com';

  it('loads the project host and Odoo sign-in, nothing else', () => {
    expect(isAllowedUrl('https://acme.odoo.com/odoo/sales', host)).toBe(true);
    expect(isAllowedUrl('https://www.odoo.com/web/login', host)).toBe(true);
    expect(isAllowedUrl('https://evil.example/', host)).toBe(false);
    expect(isAllowedUrl('https://other.odoo.com/odoo', host)).toBe(false);
    expect(isAllowedUrl('http://acme.odoo.com/odoo', host)).toBe(false);
    expect(isAllowedUrl('file:///etc/passwd', host)).toBe(false);
    expect(isAllowedUrl('http://127.0.0.1:4000/api', host)).toBe(false);
  });

  it.each([
    'https://acme.odoo.com/odoo/action-base.action_res_users',
    'https://acme.odoo.com/web#model=res.users&view_type=list',
    'https://acme.odoo.com/odoo/settings',
    'https://acme.odoo.com/web/database/manager',
    'https://acme.odoo.com/web#model=ir.cron',
    'https://acme.odoo.com/odoo/sales?debug=1',
  ])('refuses the agent on %s', (url) => {
    expect(agentUrlRefusal(url, host)).not.toBeNull();
  });

  it('lets the agent work on business screens of its own host only', () => {
    expect(agentUrlRefusal('https://acme.odoo.com/odoo/sales/12', host)).toBeNull();
    expect(agentUrlRefusal('https://acme.odoo.com/web#model=sale.order&id=4', host)).toBeNull();
    expect(agentUrlRefusal('https://www.odoo.com/web/login', host)).not.toBeNull();
  });
});
