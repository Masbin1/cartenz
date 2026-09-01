/**
 * Which addon owns a model, and which module in a repository should extend it
 * (ADR-028).
 *
 * ADR-025 ranks *files* by what they declare, which works when something already
 * extends the model. It has nothing to rank when nothing does — and then the
 * choice fell back to the first module name alphabetically.
 *
 * On a real repository that put a `sale.order` field in `pos_discount_restrict`,
 * which depends on `point_of_sale`, while `vif_sales_incentive` — which depends on
 * `sale_management` — sat unused. Both are valid Odoo modules; only one is where
 * a sales field belongs, and the manifests say which.
 *
 * So this reads the `depends` a repository already declares. It is the same idea
 * as ADR-025 applied to the case where the file does not exist yet: use what the
 * repository states about itself rather than the order a directory listing
 * happened to return.
 */

/**
 * The Odoo addon that defines each model family.
 *
 * Deliberately short. It covers the models an ERP consultancy is asked about, and
 * a model outside it simply gets no preference — which returns the previous
 * behaviour rather than a wrong answer. Guessing an owner from a prefix that is
 * not listed would be worse than admitting there is no preference.
 */
const MODEL_OWNERS: Readonly<Record<string, string>> = {
  sale: 'sale',
  purchase: 'purchase',
  account: 'account',
  stock: 'stock',
  mrp: 'mrp',
  hr: 'hr',
  project: 'project',
  crm: 'crm',
  helpdesk: 'helpdesk',
  pos: 'point_of_sale',
  product: 'product',
  repair: 'repair',
  fleet: 'fleet',
  maintenance: 'maintenance',
  quality: 'quality',
  // res.partner, res.users, res.company and friends all live in base.
  res: 'base',
};

/** The addon that defines `model`, or null when it is not a family we know. */
export function owningAddon(model: string): string | null {
  const family = model.split('.')[0]?.trim().toLowerCase();
  if (!family) return null;
  return MODEL_OWNERS[family] ?? null;
}

/**
 * Whether a dependency satisfies the owning addon.
 *
 * `sale_management` satisfies `sale`, because in Odoo the app module depends on
 * the technical one. Matched as an exact name or the owner followed by an
 * underscore, rather than a bare prefix: a bare prefix would let `accountant`
 * satisfy `account`, and a wrong module chosen confidently is worse than none.
 */
function satisfies(dependency: string, owner: string): boolean {
  const name = dependency.trim().toLowerCase();
  return name === owner || name.startsWith(`${owner}_`);
}

export interface ModuleCandidate {
  readonly technicalName: string;
  readonly depends: readonly string[];
  /** Series declared in the manifest, when it declares one. */
  readonly series?: string | null;
}

export type ModuleFit = 'depends-on-owner' | 'no-signal';

export interface RankedModule {
  readonly technicalName: string;
  readonly fit: ModuleFit;
}

/**
 * Orders modules by whether they already depend on the addon that owns the model.
 *
 * Stable within a band: modules that give no signal keep the caller's order,
 * because there is nothing better to say about them and inventing an order would
 * only hide that.
 */
export function rankModulesForModel(
  modules: readonly ModuleCandidate[],
  model: string,
): RankedModule[] {
  const owner = owningAddon(model);

  return modules
    .map((module, index) => ({
      technicalName: module.technicalName,
      fit: ((): ModuleFit =>
        owner && module.depends.some((dependency) => satisfies(dependency, owner))
          ? 'depends-on-owner'
          : 'no-signal')(),
      index,
    }))
    .sort((a, b) => {
      const rank = (fit: ModuleFit) => (fit === 'depends-on-owner' ? 0 : 1);
      return rank(a.fit) - rank(b.fit) || a.index - b.index;
    })
    .map(({ technicalName, fit }) => ({ technicalName, fit }));
}
