'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, Sparkles } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Disclosure } from '@/components/ui/disclosure';
import { SkeletonRows } from '@/components/ui/skeleton';
import {
  categoryGroups,
  filterModules,
  resolveDependencyClosure,
  type CatalogModule,
} from '@/lib/projects/module-catalog';

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
  brief,
  value,
  onChange,
}: {
  version: string;
  edition: string;
  /** The project brief; recommendations are drawn from it. */
  brief: string;
  value: string[];
  onChange: (selected: string[]) => void;
}) {
  const [catalogue, setCatalogue] = useState<CatalogModule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [appsOnly, setAppsOnly] = useState(true);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [recommending, setRecommending] = useState(false);
  const [recommendError, setRecommendError] = useState<string | null>(null);

  /** Ticks what the model suggests, on top of anything already ticked. */
  const recommend = async () => {
    setRecommending(true);
    setRecommendError(null);
    try {
      const { modules } = await api.settings.recommendOdooModules(version, edition, brief);
      if (modules.length === 0) {
        setRecommendError('No module in this catalogue matched the brief. Choose them by hand.');
        return;
      }
      setReasons(Object.fromEntries(modules.map((entry) => [entry.technicalName, entry.reason])));
      onChange([...new Set([...value, ...modules.map((entry) => entry.technicalName)])]);
    } catch (caught) {
      setRecommendError(
        caught instanceof ApiError ? caught.message : 'Modules could not be recommended. Choose them by hand.',
      );
    } finally {
      setRecommending(false);
    }
  };

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
    setReasons({});
    // Deliberately keyed on the catalogue identity, not on `onChange`: the
    // parent re-creates that callback each render, and depending on it would
    // clear the selection on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, edition]);

  const categories = useMemo(() => (catalogue ? categoryGroups(catalogue) : []), [catalogue]);

  const visible = useMemo(
    () => (catalogue ? filterModules(catalogue, { search, category, appsOnly }) : []),
    [catalogue, search, category, appsOnly],
  );

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
      <div className="panel p-5 sm:p-6" aria-busy="true">
        <p className="mb-4 text-callout text-content-muted">Reading the module catalogue…</p>
        <SkeletonRows rows={4} className="-mx-4" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-meta text-content-subtle">
          {brief.trim()
            ? 'Let the model tick what the brief needs. Review it before you create the project.'
            : 'Write the project brief first to get a recommendation.'}
        </p>
        <button
          type="button"
          onClick={recommend}
          disabled={!brief.trim() || recommending}
          className="btn-secondary btn-sm shrink-0"
        >
          <Sparkles className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          {recommending ? 'Recommending…' : 'Recommend from brief'}
        </button>
      </div>
      {recommendError ? <Alert tone="error">{recommendError}</Alert> : null}

      {/*
       * Contained: the list scrolls, and its filters and counts act on it
       * together, beside the rest of the form.
       */}
      <div className="panel overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-surface-border p-4 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <label htmlFor="module-search" className="sr-only">
              Search modules
            </label>
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-content-subtle"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              id="module-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="field-input py-2 pl-10 text-callout"
              placeholder="Search: sale, inventory, accounting…"
            />
          </div>

          <div className="flex items-center gap-4">
            <label htmlFor="module-category" className="sr-only">
              Category
            </label>
            <select
              id="module-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="field-input min-w-0 flex-1 py-2 text-callout sm:w-48 sm:flex-none"
            >
              <option value="">All categories</option>
              {categories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>

            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-callout text-content-muted">
              <input
                type="checkbox"
                checked={appsOnly}
                onChange={(event) => setAppsOnly(event.target.checked)}
              />
              Apps only
            </label>
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-callout text-content-muted">
              No module matches these filters.
            </p>
          ) : (
            visible.map((module) => {
              const checked = value.includes(module.technicalName);
              return (
                <label
                  key={module.technicalName}
                  className={`flex cursor-pointer items-center gap-3.5 rounded-lg px-3 py-2.5 transition-colors ${
                    checked ? 'bg-accent-subtle' : 'hover:bg-surface-overlay/70'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0"
                    checked={checked}
                    onChange={() => toggle(module.technicalName)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-callout font-medium text-content">
                      {module.name}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-meta text-content-subtle">
                      <span className="truncate font-mono text-caption">{module.technicalName}</span>
                      {module.category ? (
                        <span className="hidden truncate sm:inline">· {module.category}</span>
                      ) : null}
                    </span>
                    {checked && reasons[module.technicalName] ? (
                      <span className="mt-0.5 block text-meta text-accent">
                        {reasons[module.technicalName]}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })
          )}
        </div>

        <div className="flex flex-col gap-1 border-t border-surface-border px-4 py-3 text-meta text-content-subtle sm:flex-row sm:items-center sm:justify-between">
          <span>
            {visible.length} shown · {catalogue.length} available
          </span>
          <span>
            <span className="font-medium text-content">{value.length} selected</span>
            {impliedOnly.length > 0 ? ` · ${resolved.length} installed with dependencies` : ''}
          </span>
        </div>
      </div>

      {impliedOnly.length > 0 ? (
        <Disclosure
          summary="Pulled in automatically"
          hint={`${impliedOnly.length} module${impliedOnly.length === 1 ? '' : 's'}`}
        >
          <p className="text-meta text-content-subtle">
            Required by the modules you selected, so they are installed with them.
          </p>
          <p className="mt-2 font-mono text-caption leading-relaxed text-content-muted">
            {impliedOnly.join(', ')}
          </p>
        </Disclosure>
      ) : null}
    </div>
  );
}
