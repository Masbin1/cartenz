'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';

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
 * Transitive `depends` closure over the fetched catalogue — the client-side
 * twin of the backend's `resolveDependencyClosure` (ADR-056 Task 2).
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

/**
 * The module picker (ADR-056 §6). Fetches the catalogue for the chosen version
 * and edition, lets a person search it and tick modules, and shows the resolved
 * install set including dependencies they did not tick themselves.
 *
 * The refetch on version/edition change is not incidental: which modules exist
 * and what they depend on is a property of that pairing, so keeping a selection
 * made against one while showing another would offer names the install would
 * reject.
 */
export function ModulePicker({
  version,
  edition,
  value,
  onChange,
}: {
  version: string;
  edition: string;
  value: string[];
  onChange: (selected: string[]) => void;
}) {
  const [catalogue, setCatalogue] = useState<CatalogModule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [appsOnly, setAppsOnly] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setCatalogue(null);
    setError(null);

    (async () => {
      try {
        const { modules } = await api.settings.odooVersionModules(version, edition);
        if (cancelled) return;
        setCatalogue(modules);
      } catch {
        if (cancelled) return;
        setCatalogue([]);
        setError('The module catalogue could not be read for this version and edition.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [version, edition]);

  /**
   * The selection is dropped when the catalogue changes, because it was made
   * against a different one. Reported to the parent in the same effect that
   * clears the local view, so the two never disagree about what is selected.
   */
  useEffect(() => {
    onChange([]);
    // Deliberately keyed on the catalogue identity, not on `onChange`: the
    // parent re-creates that callback each render, and depending on it would
    // clear the selection on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, edition]);

  const categories = useMemo(() => {
    if (!catalogue) return [];
    const seen = new Set<string>();
    for (const module of catalogue) {
      if (module.category) seen.add(module.category);
    }
    return [...seen].sort();
  }, [catalogue]);

  const visible = useMemo(() => {
    if (!catalogue) return [];
    const needle = search.trim().toLowerCase();

    return catalogue.filter((module) => {
      if (appsOnly && !module.isApplication) return false;
      if (category && module.category !== category) return false;
      if (needle.length === 0) return true;
      return (
        module.technicalName.toLowerCase().includes(needle) ||
        module.name.toLowerCase().includes(needle)
      );
    });
  }, [catalogue, search, category, appsOnly]);

  const resolved = useMemo(
    () => (catalogue ? resolveDependencyClosure(value, catalogue) : []),
    [value, catalogue],
  );

  /**
   * What was pulled in by a dependency rather than ticked by hand, so the panel
   * can say so — a person who ticked one box and sees six modules in the count
   * needs to know the other five were not a mistake.
   */
  const impliedOnly = useMemo(
    () => resolved.filter((name) => !value.includes(name)),
    [resolved, value],
  );

  const toggle = (technicalName: string) =>
    onChange(
      value.includes(technicalName)
        ? value.filter((name) => name !== technicalName)
        : [...value, technicalName],
    );

  if (error) {
    return <Alert tone="error">{error}</Alert>;
  }

  if (!catalogue) {
    return (
      <div className="panel flex items-center gap-2 px-4 py-6 text-xs text-content-muted">
        <Spinner />
        Reading the module catalogue…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="panel">
        <div className="flex flex-wrap items-end gap-3 border-b border-surface-border px-4 py-3">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="module-search" className="field-label">
              Search
            </label>
            <input
              id="module-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="field-input py-1.5 text-xs"
              placeholder="sale, inventory, accounting…"
            />
          </div>

          <div className="min-w-[10rem]">
            <label htmlFor="module-category" className="field-label">
              Category
            </label>
            <select
              id="module-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="field-input py-1.5 text-xs"
            >
              <option value="">All categories</option>
              {categories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 pb-1.5 text-xs text-content-muted">
            <input
              type="checkbox"
              checked={appsOnly}
              onChange={(event) => setAppsOnly(event.target.checked)}
            />
            Apps only
          </label>
        </div>

        <div className="max-h-72 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-4 py-6 text-xs text-content-muted">
              No module matches these filters.
            </p>
          ) : (
            visible.map((module) => (
              <label
                key={module.technicalName}
                className="flex cursor-pointer items-start gap-3 border-b border-surface-border px-4 py-2 last:border-b-0 hover:bg-surface-overlay"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={value.includes(module.technicalName)}
                  onChange={() => toggle(module.technicalName)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{module.name}</span>
                  <span className="block font-mono text-2xs text-content-subtle">
                    {module.technicalName}
                    {module.category ? ` · ${module.category}` : ''}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-surface-border px-4 py-2 text-2xs text-content-subtle">
          <span>
            {visible.length} shown · {catalogue.length} available
          </span>
          <span>
            {value.length} selected
            {impliedOnly.length > 0 ? ` · ${resolved.length} installed with dependencies` : ''}
          </span>
        </div>
      </div>

      {impliedOnly.length > 0 ? (
        <div className="panel px-4 py-3">
          <p className="text-2xs font-medium text-content-muted">
            Pulled in automatically ({impliedOnly.length})
          </p>
          <p className="mt-1.5 font-mono text-2xs leading-relaxed text-content-subtle">
            {impliedOnly.join(', ')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
