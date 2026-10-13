/**
 * ADR-056. The catalogue entry the picker works with, mirroring the backend's
 * `CatalogModule`. Declared here rather than imported: the portal has no import
 * path into the NestJS backend's source, and the shape is small enough that a
 * duplicated type is clearer than a shared package for five fields.
 */
export interface CatalogModule {
  technicalName: string;
  name: string;
  category: string | null;
  isApplication: boolean;
  depends: string[];
}

/**
 * The leading segment of an Odoo manifest category. Categories are hierarchical
 * ("Accounting/Accounting", "Accounting/Localizations/Account Charts"), but a
 * few modules carry a single segment ("Hidden", "Human Resources").
 *
 * The picker filters by this segment, not the full path: the app itself is filed
 * under "Accounting/Accounting" while a stray data module may carry a bare
 * "Accounting", so an exact match on either string misses the other. Grouping on
 * the leading segment makes "Accounting" reach both.
 */
export function topLevelCategory(category: string | null): string | null {
  if (!category) return null;
  const [segment] = category.split('/');
  const trimmed = segment?.trim();
  return trimmed ? trimmed : null;
}

/** The distinct category groups present in a catalogue, sorted for a stable menu. */
export function categoryGroups(catalogue: readonly CatalogModule[]): string[] {
  const seen = new Set<string>();
  for (const entry of catalogue) {
    const group = topLevelCategory(entry.category);
    if (group) seen.add(group);
  }
  return [...seen].sort();
}

/**
 * The catalogue narrowed by the picker's three filters. A category matches when
 * it is the chosen group or sits beneath it ("Accounting/…"), so a group
 * selection is inclusive of its subcategories. `appsOnly` leads with the
 * manifest `application` flag; search matches the display or technical name.
 */
export function filterModules(
  catalogue: readonly CatalogModule[],
  {
    search = '',
    category = '',
    appsOnly = true,
  }: { search?: string; category?: string; appsOnly?: boolean } = {},
): CatalogModule[] {
  const needle = search.trim().toLowerCase();

  return catalogue.filter((module) => {
    if (appsOnly && !module.isApplication) return false;
    if (category && module.category !== category && !module.category?.startsWith(`${category}/`)) {
      return false;
    }
    if (needle.length === 0) return true;
    return (
      module.technicalName.toLowerCase().includes(needle) ||
      module.name.toLowerCase().includes(needle)
    );
  });
}

/**
 * Transitive `depends` closure over the fetched catalogue — the client-side twin
 * of the backend's `resolveDependencyClosure` (ADR-056 Task 2).
 *
 * The whole catalogue is already in hand, so resolving here costs no round-trip
 * and lets the panel show what will really be installed as the person ticks
 * boxes. The backend resolves the selection again, independently, against the
 * same manifests: this is what the user is shown, that is what is enforced.
 *
 * Unknown names are ignored rather than followed — a dependency outside the
 * catalogue is the backend's problem to refuse, not something to render.
 */
export function resolveDependencyClosure(
  selected: readonly string[],
  catalogue: readonly CatalogModule[],
): string[] {
  const byName = new Map(catalogue.map((module) => [module.technicalName, module]));
  const resolved = new Set<string>();
  const queue = [...selected];

  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (resolved.has(name)) continue;
    resolved.add(name);

    for (const dependency of byName.get(name)?.depends ?? []) {
      if (!resolved.has(dependency)) queue.push(dependency);
    }
  }

  return [...resolved].sort();
}
