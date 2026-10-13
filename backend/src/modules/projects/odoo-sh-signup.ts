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
