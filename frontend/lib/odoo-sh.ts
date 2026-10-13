/**
 * Odoo.sh assisted creation (ADR-071): the values of Odoo.sh's own
 * "Deploy your platform" form, so the operator copies rather than retypes them.
 */
export const ODOO_SH_CREATE_URL = 'https://www.odoo.sh/project/create';

/** Odoo.sh's region values, verbatim; `sa` is Middle East and `me` Southern Asia. */
export const ODOO_SH_REGIONS: readonly { value: string; label: string }[] = [
  { value: 'am', label: 'Americas' },
  { value: 'ca', label: 'Canada' },
  { value: 'eu', label: 'Europe' },
  { value: 'sa', label: 'Middle East' },
  { value: 'me', label: 'Southern Asia' },
  { value: 'as', label: 'Southeast Asia' },
  { value: 'au', label: 'Oceania' },
];

export const odooShRegionLabel = (value: string): string =>
  ODOO_SH_REGIONS.find((region) => region.value === value)?.label ?? value;

/** Same rules as the backend's OdooShSignupDto. */
export const ODOO_SH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const ODOO_SH_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface OdooShSignup {
  owner: string;
  repositoryName: string;
  region: string;
  odooVersion: string;
}

export function odooShSignupOf(project: {
  projectType: string;
  environmentConfig: Record<string, unknown> | null;
}): OdooShSignup | null {
  const config = project.environmentConfig;
  if (project.projectType !== 'odoo_sh' || !config || config.hosting !== 'odoo_sh') return null;
  const signup = config.signup;
  if (!signup || typeof signup !== 'object') return null;

  const value = signup as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : '');
  if (!text('owner') || !text('repositoryName')) return null;

  return {
    owner: text('owner'),
    repositoryName: text('repositoryName'),
    region: text('region'),
    odooVersion: text('odooVersion'),
  };
}
