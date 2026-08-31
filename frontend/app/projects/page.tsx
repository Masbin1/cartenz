'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert } from '@/components/ui/alert';
import { PROJECT_TYPE_LABELS, relativeTime } from '@/lib/format';
import type { ProjectSummary } from '@/lib/types';

/**
 * Wrapped in Suspense because the view reads a search parameter.
 *
 * `useSearchParams` opts a component out of static prerendering, and Next refuses
 * to build a prerendered page that uses it unbounded. The parameter carries the
 * "project deleted" notice, which arrives from a redirect after the project it
 * described no longer exists.
 */
export default function ProjectsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ProjectsView />
    </Suspense>
  );
}

function ProjectsView() {
  const { loading, user, organization } = useRequireAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [query, setQuery] = useState('');
  // Archived projects are hidden by default and reachable on request. Without
  // this they could not be found at all, and so could not be restored or deleted.
  const [showArchived, setShowArchived] = useState(false);

  // A permanent delete navigates here, because there is no project left to show.
  const params = useSearchParams();
  const deletedName = params.get('deleted');
  const deletedTasks = params.get('tasks');

  const organizationId = organization?.organizationId ?? null;

  const load = useCallback(async () => {
    if (!organizationId) return;
    setBusy(true);
    try {
      setProjects(await api.projects.list(organizationId, showArchived));
    } finally {
      setBusy(false);
    }
  }, [organizationId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !user) return <PageLoading />;

  const filtered = projects.filter((project) =>
    query.trim().length === 0
      ? true
      : `${project.name} ${project.description ?? ''} ${project.repositoryUrl ?? ''}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
  );

  const archivedCount = projects.filter((project) => project.archivedAt !== null).length;

  return (
    <AppShell>
      <div className="mx-auto max-w-[1600px] px-5 py-7">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
            <p className="mt-0.5 text-xs text-content-muted">
              {projects.length} project{projects.length === 1 ? '' : 's'} in{' '}
              {organization?.organizationName}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-content-subtle">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              Show archived
              {showArchived && archivedCount > 0 ? ` (${archivedCount})` : ''}
            </label>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter projects"
              className="field-input w-56 py-1.5 text-xs"
              aria-label="Filter projects"
            />
            <Link href="/projects/new" className="btn-primary">
              New project
            </Link>
          </div>
        </div>

        {deletedName ? (
          <Alert tone="success">
            {`"${deletedName}" was deleted permanently`}
            {deletedTasks && deletedTasks !== '0'
              ? `, with ${deletedTasks} task${deletedTasks === '1' ? '' : 's'}.`
              : '.'}
            {' The repository itself was not touched.'}
          </Alert>
        ) : null}

        {busy ? (
          <div className="panel">
            <p className="px-4 py-10 text-center text-xs text-content-subtle">Loading projects</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="panel">
            <EmptyState
              title={projects.length === 0 ? 'No projects yet' : 'No project matches that filter'}
              description={
                projects.length === 0
                  ? 'Connect an existing Odoo repository, or have the agent specify a new project from a description and a list of requirements.'
                  : 'Adjust the filter to see more projects.'
              }
              action={
                projects.length === 0 ? (
                  <Link href="/projects/new" className="btn-primary">
                    New project
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="panel flex flex-col p-4 transition-colors hover:border-content-subtle"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="truncate text-sm font-semibold">
                    {project.name}
                    {project.archivedAt ? (
                      <span className="ml-2 rounded border border-surface-border px-1.5 py-0.5 align-middle text-2xs font-normal text-content-subtle">
                        archived
                      </span>
                    ) : null}
                  </h2>
                  <span className="shrink-0 rounded border border-surface-border px-1.5 py-0.5 text-2xs text-content-subtle">
                    {PROJECT_TYPE_LABELS[project.projectType] ?? project.projectType}
                  </span>
                </div>

                <p className="mt-2 line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-content-muted">
                  {project.description ?? 'No description.'}
                </p>

                {project.repositoryUrl ? (
                  <p className="mt-2 truncate font-mono text-2xs text-content-subtle">
                    {project.repositoryUrl}
                  </p>
                ) : null}

                <div className="mt-4 flex items-center justify-between border-t border-surface-border pt-3 text-2xs text-content-subtle">
                  <span>
                    {project.odooVersion ? `Odoo ${project.odooVersion}` : 'Version not set'} ·{' '}
                    {project.defaultBranch}
                  </span>
                  <span>
                    {project.openTaskCount > 0 ? (
                      <span className="text-state-running">{project.openTaskCount} open</span>
                    ) : (
                      `${project.taskCount} tasks`
                    )}
                  </span>
                </div>

                <p className="mt-1 text-2xs text-content-subtle">
                  Updated {relativeTime(project.updatedAt)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
