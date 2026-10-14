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

/**
 * A bookmarklet that fills odoo.sh's "Deploy your platform" form from the plan.
 *
 * odoo.sh reads nothing from its URL and can only be submitted from the
 * operator's own session, so the values are filled in their browser: run on
 * odoo.sh/project/create, this picks "New repository", sets owner, name and
 * version, and clicks the region on the map, firing the events the form
 * listens to. The subscription code and Deploy stay with the operator.
 *
 * ponytail: selectors mirror odoo.sh's markup as of 2026-10-14; if they rename
 * a field, that field is silently left for the operator to fill.
 */
export function odooShFillBookmarklet(signup: OdooShSignup): string {
  const values = {
    owner: signup.owner,
    name: signup.repositoryName,
    version: signup.odooVersion,
    region: signup.region,
  };
  const script = `(()=>{const v=${JSON.stringify(values)};const f=document.querySelector('form.o_project_create');if(!f){alert('Open odoo.sh/project/create first.');return}const fire=(e,t)=>e.dispatchEvent(new Event(t,{bubbles:true}));const set=(s,x)=>{const e=f.querySelector(s);if(!e||!x)return;e.value=x;fire(e,'input');fire(e,'change')};const r=f.querySelector('input[type="radio"][value="create"]');if(r&&!r.checked){r.click()}setTimeout(()=>{set('select#owner',v.owner);set('input[name="name"]',v.name);set('select[name="odoo_branch"]',v.version);const c=document.querySelector('circle.trigger[location="'+v.region+'"]');if(c)c.dispatchEvent(new MouseEvent('click',{bubbles:true}))},300)})()`;
  return `javascript:${encodeURIComponent(script)}`;
}
