/**
 * What the in-portal browser may load and what the agent may do in it
 * (ADR-087, Option B).
 *
 * Pure functions, so the rules are tested without a Chromium. They are not the
 * record surface's guarantees - ADR-087 is explicit that a driven browser cannot
 * have those - they are the narrower ones that *can* be enforced:
 *
 * - the session stays on the project's own Odoo Online host (and odoo.com's
 *   login pages), so the browser is not a general web proxy on this host;
 * - the screens ADR-087 open question 4 named (users, access, technical
 *   settings, database manager) are refused by URL, not by prompt;
 * - the agent reaches elements only through the snapshot's refs.
 */

/** Hosts a session may load besides the project's own: Odoo's own sign-in. */
const LOGIN_HOSTS = ['www.odoo.com', 'accounts.odoo.com'];

/**
 * URL fragments of screens the agent is never driven onto, even in an approved
 * session. Matched against path + query + hash, lower-cased. Odoo 17+ uses
 * `/odoo/action-...` paths and 16- uses `#model=...&action=...`; both forms are
 * covered by matching the model or action name wherever it appears.
 *
 * ponytail: a substring deny-list. A determined page can reach these screens by
 * a path this list does not name (a renamed menu, a custom action); that is the
 * residual risk ADR-087 accepted for Option B, which is why a person watches.
 */
const AGENT_BLOCKED_FRAGMENTS = [
  '/web/database',
  'res.users',
  'res.groups',
  'res.config.settings',
  'ir.',
  'base.module',
  'action-base.',
  '/odoo/settings',
  'debug=',
];

export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether the session may load this URL at all (any request, by anyone). */
export function isAllowedUrl(url: string, projectHost: string): boolean {
  const host = hostOf(url);
  if (!host) return url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:');
  return host === projectHost || LOGIN_HOSTS.includes(host) || host.endsWith('.odoocdn.com');
}

/** Why the agent may not be on this URL, or null when it may. */
export function agentUrlRefusal(url: string, projectHost: string): string | null {
  if (hostOf(url) !== projectHost) {
    return `the agent works only on ${projectHost}`;
  }
  const parsed = new URL(url);
  const target = decodeURIComponent(`${parsed.pathname}${parsed.search}${parsed.hash}`).toLowerCase();
  const blocked = AGENT_BLOCKED_FRAGMENTS.find((fragment) => target.includes(fragment));
  return blocked
    ? `"${blocked}" screens (users, access, settings, technical, database manager) are never driven by the agent`
    : null;
}

/** A snapshot element reference, as `ariaSnapshot({ mode: 'ai' })` prints them. */
export const ELEMENT_REF = /^e\d{1,6}$/;

/** Snapshot text is capped so one page cannot fill the model's context. */
export const MAX_SNAPSHOT_CHARS = 30_000;

export const MAX_TYPE_CHARS = 2_000;
