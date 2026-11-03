/**
 * What the in-portal browser may load (ADR-087, Option C: full access).
 *
 * Pure functions, so the rules are tested without a Chromium. ADR-087
 * Option B's URL deny-list (users, access, technical settings, database
 * manager, debug mode) was removed by explicit operator decision (ADR-090):
 * the agent is driven in the person's own logged-in session and may reach
 * anything that session can reach, the same as the person watching it could
 * by hand. The one guarantee kept is the host boundary below - the session
 * stays on the project's own Odoo Online host (and odoo.com's login pages),
 * so a driven browser is not a general web proxy onto the rest of the
 * internet from this server.
 */

/** Hosts a session may load besides the project's own: Odoo's own sign-in. */
const LOGIN_HOSTS = ['www.odoo.com', 'accounts.odoo.com'];

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

/**
 * Why the agent may not be on this URL, or null when it may.
 *
 * ADR-090: narrowed to the host boundary only. There is no longer a set of
 * screens the agent is refused within its own host - Settings, Technical,
 * Users, the database manager and debug mode are all reachable, by operator
 * decision, the same as they are to the person who is signed in and
 * watching.
 */
export function agentUrlRefusal(url: string, projectHost: string): string | null {
  if (hostOf(url) !== projectHost) {
    return `the agent works only on ${projectHost}`;
  }
  return null;
}

/** A snapshot element reference, as `ariaSnapshot({ mode: 'ai' })` prints them. */
export const ELEMENT_REF = /^e\d{1,6}$/;

/** Snapshot text is capped so one page cannot fill the model's context. */
export const MAX_SNAPSHOT_CHARS = 30_000;

export const MAX_TYPE_CHARS = 2_000;
