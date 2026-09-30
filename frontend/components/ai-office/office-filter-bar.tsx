'use client';

import { memo } from 'react';
import type { AiOfficePhase } from '@/lib/types';
import { DEPARTMENTS, type OfficeFilters } from '@/lib/office/model';

/**
 * Department and project filters (sections 20-21).
 *
 * Filtering never removes an agent from the model; it only asks the canvas to
 * dim what falls outside scope, so choosing "Development" cannot make the
 * office look like it has fewer real tasks than it does.
 */
export const OfficeFilterBar = memo(function OfficeFilterBar({
  filters,
  onChange,
  projects,
}: {
  filters: OfficeFilters;
  onChange: (next: OfficeFilters) => void;
  projects: { id: string; name: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 rounded-control border border-surface-border bg-surface-raised p-1">
        <FilterPill
          active={filters.department === 'all'}
          onClick={() => onChange({ ...filters, department: 'all' })}
        >
          All
        </FilterPill>
        {DEPARTMENTS.map((department) => (
          <FilterPill
            key={department.id}
            active={filters.department === department.id}
            onClick={() =>
              onChange({
                ...filters,
                department: (filters.department === department.id ? 'all' : department.id) as
                  AiOfficePhase | 'all',
              })
            }
          >
            {department.name}
          </FilterPill>
        ))}
      </div>

      {projects.length > 1 ? (
        <label className="flex items-center gap-2">
          <span className="sr-only">Project</span>
          <select
            value={filters.projectId}
            onChange={(event) => onChange({ ...filters, projectId: event.target.value })}
            className="h-8 max-w-[12rem] truncate rounded-lg border border-surface-border bg-surface-raised px-2 text-meta text-content transition-colors hover:border-surface-strong focus:outline-none"
          >
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
});

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-meta font-medium transition-colors ${
        active
          ? 'bg-accent text-white'
          : 'text-content-muted hover:bg-surface-overlay hover:text-content'
      }`}
    >
      {children}
    </button>
  );
}
