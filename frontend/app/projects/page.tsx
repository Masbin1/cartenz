'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
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
            {filtered.map((project) =>
              project.hasAccess ? (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className={`${CARD_CLASSES} transition-colors hover:border-content-subtle`}
                >
                  {renderCardBody(project)}
                </Link>
              ) : (
                /*
                 * Not a link that refuses — not a link (ADR-043). The project keeps
                 * its place in the list because what is withheld is access, not
                 * existence, but a card that navigated to a 403 would be a worse
                 * way to learn that.
                 */
                <div key={project.id} className={`${CARD_CLASSES} opacity-60`}>
                  {renderCardBody(project)}
                  <AccessRequestButton
                    projectId={project.id}
                    status={project.accessRequestStatus}
                    onRequested={load}
                  />
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

const CARD_CLASSES = 'panel flex flex-col p-4';

/**
 * The card's contents, shared by the link and the locked card so the two sit
 * identically in the grid. A locked project arrives with its description,
 * repository and task counts nulled by the server, so each is guarded here.
 */
function renderCardBody(project: ProjectSummary) {
  return (
    <>
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
                  {project.hasAccess ? (project.description ?? 'No description.') : 'Access required.'}
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
                    {!project.hasAccess ? (
                      'Locked'
                    ) : (project.openTaskCount ?? 0) > 0 ? (
                      <span className="text-state-running">{project.openTaskCount} open</span>
                    ) : (
                      `${project.taskCount ?? 0} tasks`
                    )}
                  </span>
                </div>

                <p className="mt-1 text-2xs text-content-subtle">
                  Updated {relativeTime(project.updatedAt)}
                </p>
    </>
  );
}

/**
 * Ask for access to a project in the list (ADR-043).
 *
 * The reason is optional — requiring one would mostly produce empty ones — and
 * a rejected request can be made again, because circumstances change and a
 * refusal is not a ban.
 */
function AccessRequestButton({
  projectId,
  status,
  onRequested,
}: {
  projectId: string;
  status: 'pending' | 'rejected' | null;
  onRequested: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'pending') {
    return <p className="mt-3 text-2xs text-content-subtle">Awaiting approval</p>;
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.access.requestAccess(projectId, reason.trim() || undefined);
      setOpen(false);
      setReason('');
      onRequested();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The request could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 self-start text-2xs text-content-muted underline hover:text-content"
      >
        {status === 'rejected' ? 'Request again' : 'Request access'}
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <label htmlFor={`access-reason-${projectId}`} className="sr-only">
        Why you need access
      </label>
      <textarea
        id={`access-reason-${projectId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why do you need access? (optional)"
        rows={2}
        className="field-input w-full py-1.5 text-2xs"
      />
      {error ? <p className="text-2xs text-state-failure">{error}</p> : null}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="text-2xs text-content-muted underline hover:text-content disabled:opacity-40"
        >
          {busy ? 'Sending' : 'Send request'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-2xs text-content-subtle"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
