/**
 * The Odoo.sh deploy plan recorded at creation (ADR-071), read back from
 * `environment_config`. Null for anything that is not an assisted Odoo.sh
 * project, including one connected the older way, which has no plan.
 */
export interface OdooShSignup {
  readonly owner: string;
  readonly repositoryName: string;
  readonly region: string;
  readonly odooVersion: string;
}

export function odooShSignupOf(environmentConfig: unknown): OdooShSignup | null {
  if (!environmentConfig || typeof environmentConfig !== 'object') return null;
  const config = environmentConfig as Record<string, unknown>;
  if (config.hosting !== 'odoo_sh' || !config.signup || typeof config.signup !== 'object') return null;

  const signup = config.signup as Record<string, unknown>;
  const text = (key: string) => (typeof signup[key] === 'string' ? (signup[key] as string) : '');
  if (!text('owner') || !text('repositoryName')) return null;

  return {
    owner: text('owner'),
    repositoryName: text('repositoryName'),
    region: text('region'),
    odooVersion: text('odooVersion'),
  };
}

/**
 * Which GitHub token the Odoo.sh connect step uses (ADR-071).
 *
 * A registered access token wins. `GITHUB_TOKEN` is the fallback only when the
 * operator chose nothing. A credential they did choose is never swapped for
 * another token: that would act with access they did not pick.
 */
export function chooseOdooShToken(input: {
  readonly credentialId: string | null;
  readonly registered: { kind: string; value: string; credentialId: string | null } | null;
  readonly fallback: string | null;
}): { token: string | null; credentialId: string | null } {
  if (input.registered?.kind === 'token') {
    return { token: input.registered.value, credentialId: input.registered.credentialId };
  }
  if (input.credentialId) {
    throw new Error('The chosen credential is not an enabled access token for github.com.');
  }
  return { token: input.fallback, credentialId: null };
}
