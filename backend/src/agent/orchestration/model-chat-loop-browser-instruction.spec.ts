import { ODOO_ONLINE_CHAT_INSTRUCTION } from './model-chat-loop';

/**
 * ADR-090: the chat loop's Odoo Online instruction describes the signed-in
 * browser's reach. This was the first place the old ADR-087 Option B
 * deny-list wording ("Users, access rights, settings, technical menus and
 * debug mode are refused") lived; ADR-090 updated it when the policy
 * changed, and this pins that it stays updated.
 */
describe('ODOO_ONLINE_CHAT_INSTRUCTION — the signed-in browser (ADR-090)', () => {
  const text = ODOO_ONLINE_CHAT_INSTRUCTION;

  it('tells the model nothing on the host is refused to the browser', () => {
    expect(text).toContain('Nothing within this Odoo host is refused to the browser');
  });

  it('names Automation Rules and Server Actions as reachable', () => {
    expect(text).toContain('Automation Rules');
    expect(text).toContain('Server Actions');
  });

  it('does not carry the superseded ADR-087 Option B deny-list wording', () => {
    expect(text).not.toMatch(/are refused\b/);
    expect(text).not.toContain('technical menus and debug mode are refused');
  });
});
