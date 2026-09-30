'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, FolderGit2, Lock, Plus, Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageHeader } from '@/components/ui/page';
import { PageLoading } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert } from '@/components/ui/alert';
import { SkeletonRows } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/ui/status-dot';
import { PROJECT_TYPE_LABELS, relativeTime } from '@/lib/format';
import { USER_REGION_LABELS } from '@/lib/types';
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

/**
 * The projects a person works in, as an open list rather than a grid of cards.
 *
 * A project is a workspace someone returns to, and the question the page
 * answers is "which one, and is anything happening in it". A single column of
 * rows lets the names be scanned top to bottom, keeps the supporting facts
 * aligned, and leaves the open-task count as the one thing on the right.
 */
function ProjectsView() {
  const { loading, user } = useRequireAuth();
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

  const load = useCallback(async () => {
    if (!user) return;
    setBusy(true);
    try {
      setProjects(await api.projects.list(showArchived));
    } finally {
      setBusy(false);
    }
  }, [user, showArchived]);

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
      <div className="page">
        <PageHeader
          title="Projects"
          description={`${projects.length} project${projects.length === 1 ? '' : 's'} in ${
            USER_REGION_LABELS[user.region]
          }`}
          actions={
            <Link href="/projects/new" className="btn-primary">
              <Plus className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
              New project
            </Link>
          }
        />

        {deletedName ? (
          <div className="mb-8">
            <Alert tone="success">
              {`"${deletedName}" was deleted permanently`}
              {deletedTasks && deletedTasks !== '0'
                ? `, with ${deletedTasks} task${deletedTasks === '1' ? '' : 's'}.`
                : '.'}
              {' The repository itself was not touched.'}
            </Alert>
          </div>
        ) : null}

        {/* Quiet controls under the header, so the header keeps one action. */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-content-subtle"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter projects"
              className="field-input py-2 pl-10 text-callout"
              aria-label="Filter projects"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-callout text-content-muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Show archived
            {showArchived && archivedCount > 0 ? (
              <span className="text-content-subtle">({archivedCount})</span>
            ) : null}
          </label>
        </div>

        {busy ? (
          <SkeletonRows rows={5} className="-mx-4" />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={projects.length === 0 ? FolderGit2 : Search}
            title={projects.length === 0 ? 'No projects yet' : 'No project matches that filter'}
            description={
              projects.length === 0
                ? 'Connect an existing Odoo repository, or have the agent specify a new project from a description and a list of requirements.'
                : 'Adjust the filter to see more projects.'
            }
            action={
              projects.length === 0 ? (
                <Link href="/projects/new" className="btn-primary">
                  Create project
                </Link>
              ) : undefined
            }
          />
        ) : (
          <ul className="-mx-4 animate-fade-in space-y-1">
            {filtered.map((project) =>
              project.hasAccess ? (
                <li key={project.id}>
                  <Link href={`/projects/${project.id}`} className="list-row group items-start sm:items-center">
                    <ProjectRowBody project={project} />
                    <ChevronRight
                      className="mt-2.5 hidden h-4 w-4 shrink-0 text-content-subtle opacity-0 transition-opacity group-hover:opacity-100 sm:mt-0 sm:block"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ) : (
                /*
                 * Not a link that refuses — not a link (ADR-043). The project keeps
                 * its place in the list because what is withheld is access, not
                 * existence, but a row that navigated to a 403 would be a worse
                 * way to learn that.
                 */
                <li key={project.id} className="flex items-start gap-4 rounded-xl px-4 py-3.5">
                  <ProjectRowBody project={project}>
                    <AccessRequestButton
                      projectId={project.id}
                      status={project.accessRequestStatus}
                      onRequested={load}
                    />
                  </ProjectRowBody>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

/**
 * One project's row, shared by the link and the locked row so the two align in
 * the list. A locked project arrives with its description, repository and task
 * counts nulled by the server, so each is guarded here; it recedes (muted name,
 * lowered opacity) while its access-request control, passed as children, stays
 * at full strength so it can still be used.
 */
function ProjectRowBody({
  project,
  children,
}: {
  project: ProjectSummary;
  children?: ReactNode;
}) {
  const locked = !project.hasAccess;
  const openTasks = project.openTaskCount ?? 0;

  return (
    <>
      <span
        className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-overlay text-callout font-semibold text-content-muted sm:mt-0 ${
          locked ? 'opacity-60' : ''
        }`}
        aria-hidden="true"
      >
        {locked ? (
          <Lock className="h-4 w-4" strokeWidth={1.75} />
        ) : (
          project.name.trim().charAt(0).toUpperCase() || '·'
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className={locked ? 'opacity-60' : ''}>
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className={`truncate text-body font-semibold ${locked ? 'text-content-muted' : 'text-content'}`}
            >
              {project.name}
            </span>
            {project.archivedAt ? (
              <span className="shrink-0 text-meta text-content-subtle">Archived</span>
            ) : null}
          </div>

          <p className="mt-0.5 line-clamp-1 text-callout text-content-muted">
            {project.hasAccess ? (project.description ?? 'No description') : 'Access required'}
          </p>

          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta text-content-subtle">
            <span>{PROJECT_TYPE_LABELS[project.projectType] ?? project.projectType}</span>
            <span aria-hidden="true">·</span>
            <span>{project.odooVersion ? `Odoo ${project.odooVersion}` : 'Version not set'}</span>
            <span aria-hidden="true" className="hidden sm:inline">
              ·
            </span>
            <span className="hidden font-mono text-caption sm:inline">{project.defaultBranch}</span>
            <span aria-hidden="true">·</span>
            <span>Updated {relativeTime(project.updatedAt)}</span>
          </p>

          {project.repositoryUrl ? (
            <p className="mono-meta mt-1 hidden truncate md:block">{project.repositoryUrl}</p>
          ) : null}
        </div>

        {children}
      </div>

      <div className={`shrink-0 pt-0.5 sm:pt-0 ${locked ? 'opacity-60' : ''}`}>
        {locked ? (
          <StatusDot tone="neutral" size="small">
            Locked
          </StatusDot>
        ) : openTasks > 0 ? (
          <StatusDot tone="running" size="small">
            {project.openTaskCount} open
          </StatusDot>
        ) : (
          <span className="text-meta text-content-subtle">
            {project.taskCount ?? 0} task{(project.taskCount ?? 0) === 1 ? '' : 's'}
          </span>
        )}
      </div>
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
    return (
      <div className="mt-3">
        <StatusDot tone="waiting" size="small">
          Access requested, awaiting approval
        </StatusDot>
      </div>
    );
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
        className="btn-secondary btn-sm mt-3"
      >
        {status === 'rejected' ? 'Request again' : 'Request access'}
      </button>
    );
  }

  return (
    <div className="mt-3 max-w-md animate-rise-in space-y-3">
      <label htmlFor={`access-reason-${projectId}`} className="sr-only">
        Why you need access
      </label>
      <textarea
        id={`access-reason-${projectId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why do you need access? (optional)"
        rows={2}
        className="field-input text-callout"
      />
      {error ? <p className="field-error mt-0">{error}</p> : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="btn-primary btn-sm"
        >
          {busy ? 'Sending' : 'Send request'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
