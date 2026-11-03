import { agentUrlRefusal, isAllowedUrl } from './browser-policy';

/**
 * The browser session's boundary (ADR-090: Option C, full access within the
 * project's own host). The agent reaches anything the signed-in person's
 * session can reach, including Settings, Technical, Users and debug mode -
 * the only remaining guarantee is the host itself: the session never loads a
 * different site, which is what keeps it from being a general web proxy on
 * this server rather than a tool scoped to one Odoo instance.
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
    'https://acme.odoo.com/odoo/action-base_automation.base_automation_act',
  ])('allows the agent on its own host at %s (ADR-090)', (url) => {
    expect(agentUrlRefusal(url, host)).toBeNull();
  });

  it('refuses a URL on a different host', () => {
    expect(agentUrlRefusal('https://other.odoo.com/odoo/sales', host)).not.toBeNull();
    expect(agentUrlRefusal('https://evil.example/', host)).not.toBeNull();
  });

  it('lets the agent work on business screens of its own host', () => {
    expect(agentUrlRefusal('https://acme.odoo.com/odoo/sales/12', host)).toBeNull();
    expect(agentUrlRefusal('https://acme.odoo.com/web#model=sale.order&id=4', host)).toBeNull();
    // Odoo's own sign-in is a different host, so it is still refused to the
    // agent even though a person's browser may be sent there to sign in.
    expect(agentUrlRefusal('https://www.odoo.com/web/login', host)).not.toBeNull();
  });
});
