import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOdooManifest } from '../../agent/analysis/manifest-parser';

/**
 * ADR-056. What the module picker offers, read from the manifests the host
 * actually has — not a hardcoded list that drifts from what a project would
 * really install.
 */
export interface CatalogModule {
  readonly technicalName: string;
  readonly name: string;
  readonly category: string | null;
  readonly isApplication: boolean;
  readonly depends: readonly string[];
}

/**
 * Lists installable modules across one or more addon directories, de-duplicated
 * by technical name (first path wins — community before enterprise, matching
 * the order callers pass) and sorted by display name for a stable picker order.
 *
 * Mirrors `build-odoo-templates.sh`'s `list_modules()`: skip dotfiles and
 * `test_*` directories, require a `__manifest__.py`, and require
 * `installable` is not explicitly `False`. The two must never disagree, since
 * one decides what a template builds and the other decides what a person can
 * ask for.
 */
export async function enumerateModules(addonPaths: readonly string[]): Promise<CatalogModule[]> {
  const byName = new Map<string, CatalogModule>();

  for (const addonPath of addonPaths) {
    const entries = await readdir(addonPath).catch(() => null);
    if (!entries) continue; // Not on this host: skipped, not fatal.

    for (const entry of entries.sort()) {
      if (entry.startsWith('.') || entry.startsWith('test_')) continue;
      if (byName.has(entry)) continue; // Earlier path already supplied this name.

      const modulePath = join(addonPath, entry);
      const manifestPath = join(modulePath, '__manifest__.py');

      const [isDirectory, manifestSource] = await Promise.all([
        stat(modulePath)
          .then((info) => info.isDirectory())
          .catch(() => false),
        readFile(manifestPath, 'utf8').catch(() => null),
      ]);
      if (!isDirectory || manifestSource === null) continue;

      const manifest = parseOdooManifest(entry, manifestSource);
      if (manifest.installable === false) continue;

      byName.set(entry, {
        technicalName: entry,
        name: manifest.name ?? entry,
        category: manifest.category,
        isApplication: manifest.applicationFlag === true,
        depends: manifest.depends,
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The selected set plus every transitive dependency, resolved against the
 * catalog's own `depends` field — so selecting `sale_management` also pulls
 * `sale` and `mail` without the caller enumerating them.
 *
 * `unknown` lists any selected name absent from the catalog. Resolution itself
 * has no concept of an HTTP error; the caller turns `unknown` into a
 * `BadRequestException`.
 */
export function resolveDependencyClosure(
  selected: readonly string[],
  catalog: readonly CatalogModule[],
): { resolved: string[]; unknown: string[] } {
  const byName = new Map(catalog.map((m) => [m.technicalName, m] as const));
  const unknown = selected.filter((name) => !byName.has(name));

  const visited = new Set<string>();
  const queue = [...selected].filter((name) => byName.has(name));

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const module = byName.get(name);
    if (!module) continue; // A dependency not in the catalog: silently unresolved, not an error.
    for (const dependency of module.depends) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }

  return { resolved: [...visited].sort(), unknown };
}
