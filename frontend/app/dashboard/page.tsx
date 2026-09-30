'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleCheckBig,
  FolderGit2,
  Hand,
  History,
  ListChecks,
  Lock,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusDot } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import {
  PROJECT_TYPE_LABELS,
  humanise,
  isActiveStatus,
  relativeTime,
  type StatusTone,
} from '@/lib/format';
import { USER_REGION_LABELS } from '@/lib/types';
import type {
  AuditLogEntry,
  PendingApprovalSummary,
  ProjectSummary,
  TaskSummary,
} from '@/lib/types';

/**
 * The overview answers three questions in order of urgency: what is waiting for
 * me, what is running, and what has recently happened. Anything that does not
 * answer one of those is not on this page.
 *
 * Unlike the rest of the portal, every group here sits in its own card: a
 * dashboard is scanned as a set of separate blocks, and on the open layout the
 * summary, approvals, tasks and projects ran into one another. Approvals come
 * first and span the full width, because they are the only block that asks
 * something of the reader.
 */
export default function DashboardPage() {
  const { loading, user } = useRequireAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [approvals, setApprovals] = useState<PendingApprovalSummary[]>([]);
  const [tasks, setTasks] = useState<(TaskSummary & { projectId: string; projectName: string })[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [busy, setBusy] = useState(true);

  const canReadAudit = user?.isAdmin ?? false;

  const load = useCallback(async () => {
    if (!user) return;
    setBusy(true);
    try {
      const [projectList, pending] = await Promise.all([
        api.projects.list(),
        api.approvals.pending(),
      ]);

      setProjects(projectList);
      setApprovals(pending);

      // Recent tasks are gathered from the projects that have any, newest first.
      // A locked project reports a null count and is skipped: it has no tasks
      // this person may read (ADR-043).
      const withTasks = projectList.filter((project) => (project.taskCount ?? 0) > 0).slice(0, 8);
      const taskLists = await Promise.all(
        withTasks.map(async (project) => {
          const list = await api.tasks.listForProject(project.id);
          return list.map((task) => ({ ...task, projectId: project.id, projectName: project.name }));
        }),
      );
      setTasks(
        taskLists
          .flat()
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10),
      );

      if (canReadAudit) {
        setAudit(await api.settings.auditLogs(12));
      }
    } finally {
      setBusy(false);
    }
  }, [canReadAudit, user]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !user) return <PageLoading label="Loading your session" />;

  const activeTasks = tasks.filter((task) => isActiveStatus(task.status));
  const completedTasks = tasks.filter((task) => task.status === 'completed');
  const firstName = user.name.split(/\s+/).filter(Boolean)[0] ?? user.name;

  return (
    <AppShell>
      <div className="page">
        <header className="mb-8 flex animate-rise-in flex-col gap-5 sm:mb-10 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="eyebrow">Overview · {USER_REGION_LABELS[user.region]}</p>
            <h1 className="mt-1.5 text-display-sm text-content sm:text-display">
              {greeting()}, {firstName}
            </h1>
            <p className="mt-2 text-body text-content-muted sm:text-[1.0625rem] sm:leading-7">
              {busy
                ? 'Gathering what is happening across your projects.'
                : approvals.length > 0
                  ? `${approvals.length === 1 ? 'One request needs' : `${approvals.length} requests need`} your approval.`
                  : "You're all caught up. Here is what is happening across your projects."}
            </p>
          </div>
          <Link href="/projects/new" className="btn-primary shrink-0 self-start sm:self-auto">
            <Plus className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            New project
          </Link>
        </header>

        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Metric
              label="Projects"
              hint="In your region"
              value={projects.length}
              icon={FolderGit2}
              tone="neutral"
              busy={busy}
            />
            <Metric
              label="Active tasks"
              hint="Being worked on now"
              value={activeTasks.length}
              icon={Activity}
              tone="running"
              busy={busy}
            />
            <Metric
              label="Awaiting approval"
              hint={approvals.length > 0 ? 'Waiting for you' : 'Nothing waiting'}
              value={approvals.length}
              icon={Hand}
              tone="waiting"
              busy={busy}
              highlight={approvals.length > 0}
            />
            <Metric
              label="Completed"
              hint="Of the latest tasks"
              value={completedTasks.length}
              icon={CircleCheckBig}
              tone="success"
              busy={busy}
            />
          </dl>

          <Card
            title="Awaiting your approval"
            icon={Hand}
            tone="waiting"
            count={busy ? undefined : approvals.length}
            highlight={!busy && approvals.length > 0}
          >
            {busy ? (
              <SkeletonRows rows={2} />
            ) : approvals.length === 0 ? (
              <div className="flex animate-fade-in items-center gap-4 px-5 py-6 sm:px-6">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-state-success/10 text-state-success">
                  <CheckCircle2 className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-body font-medium text-content">You&apos;re all caught up</p>
                  <p className="mt-0.5 text-callout text-content-muted">
                    When the agent needs your authorisation, it pauses and the request appears
                    here.
                  </p>
                </div>
              </div>
            ) : (
              <ul className="animate-fade-in divide-y divide-surface-border">
                {approvals.map((approval) => (
                  <li
                    key={approval.id}
                    className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-body font-medium text-content">
                        {humanise(approval.action)}
                      </p>
                      <p className="mt-0.5 text-callout text-content-muted">
                        {approval.requiredReason}
                      </p>
                      <p className="mt-1.5 text-meta text-content-subtle">
                        {approval.projectName}
                        <span className="hidden sm:inline">
                          {' · '}
                          <span className="font-mono text-caption">{approval.taskReference}</span>
                        </span>
                        {' · '}
                        {relativeTime(approval.requestedAt)}
                      </p>
                    </div>
                    <Link
                      href={`/projects/${approval.projectId}/agent?task=${approval.taskId}`}
                      className="btn-primary btn-sm shrink-0 self-start sm:self-auto"
                    >
                      Review
                      <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card
              title="Recent tasks"
              icon={ListChecks}
              tone="running"
              className="lg:col-span-3"
            >
              {busy ? (
                <SkeletonRows rows={4} />
              ) : tasks.length === 0 ? (
                <EmptyState
                  compact
                  icon={ListChecks}
                  title="No tasks yet"
                  description="Open a project's agent workspace and describe a change to create the first one."
                />
              ) : (
                <ul className="animate-fade-in divide-y divide-surface-border">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <Link
                        href={`/projects/${task.projectId}/agent?task=${task.id}`}
                        className="flex items-start gap-4 px-5 py-3.5 transition-colors hover:bg-surface-overlay/60 sm:px-6"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-callout font-medium text-content">
                            {task.prompt}
                          </p>
                          <p className="mt-1 text-meta text-content-subtle">
                            {task.projectName}
                            <span className="hidden sm:inline">
                              {' · '}
                              <span className="font-mono text-caption">{task.reference}</span>
                            </span>
                            {' · '}
                            {relativeTime(task.createdAt)}
                          </p>
                        </div>
                        <StatusBadge status={task.status} className="mt-0.5 shrink-0" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Projects"
              icon={FolderGit2}
              tone="neutral"
              className="lg:col-span-2"
              action={
                <Link
                  href="/projects"
                  className="inline-flex items-center gap-0.5 text-callout text-content-muted transition-colors hover:text-content"
                >
                  View all
                  <ChevronRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                </Link>
              }
            >
              {busy ? (
                <SkeletonRows rows={3} />
              ) : projects.length === 0 ? (
                <EmptyState
                  compact
                  icon={FolderGit2}
                  title="No projects yet"
                  description="Connect an existing Odoo repository, or have the agent specify a new project for you."
                  action={
                    <Link href="/projects/new" className="btn-primary">
                      Create project
                    </Link>
                  }
                />
              ) : (
                <ul className="animate-fade-in divide-y divide-surface-border">
                  {projects.slice(0, 6).map((project) => {
                    const rowClasses = 'flex items-center gap-3.5 px-5 py-3.5 sm:px-6';
                    const body = (
                      <>
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-callout font-semibold ${
                            project.hasAccess
                              ? 'bg-accent/10 text-accent'
                              : 'bg-surface-overlay text-content-subtle'
                          }`}
                          aria-hidden="true"
                        >
                          {project.hasAccess ? (
                            project.name.trim().charAt(0).toUpperCase()
                          ) : (
                            <Lock className="h-4 w-4" strokeWidth={1.75} />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-callout font-medium text-content">
                            {project.name}
                          </p>
                          <p className="mt-0.5 truncate text-meta text-content-subtle">
                            {PROJECT_TYPE_LABELS[project.projectType] ?? project.projectType}
                            {project.odooVersion ? ` · Odoo ${project.odooVersion}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1 text-meta text-content-subtle">
                          {project.hasAccess ? (
                            (project.openTaskCount ?? 0) > 0 ? (
                              <StatusDot tone="running" size="small">
                                {project.openTaskCount} open
                              </StatusDot>
                            ) : (
                              <span className="tabular-nums">{project.taskCount ?? 0} tasks</span>
                            )
                          ) : (
                            <span>Locked</span>
                          )}
                        </div>
                      </>
                    );
                    return (
                      <li key={project.id}>
                        {project.hasAccess ? (
                          <Link
                            href={`/projects/${project.id}`}
                            className={`${rowClasses} transition-colors hover:bg-surface-overlay/60`}
                          >
                            {body}
                          </Link>
                        ) : (
                          /* Listed, not linked: the link would only lead to a 403.
                             Asking for access happens on /projects (ADR-043). */
                          <div className={`${rowClasses} opacity-60`}>{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          {canReadAudit ? (
            <Card title="Audit trail" icon={History} tone="neutral">
              {busy ? (
                <SkeletonRows rows={3} />
              ) : audit.length === 0 ? (
                <p className="px-5 py-6 text-callout text-content-subtle sm:px-6">
                  No entries yet. Actions are recorded as they occur.
                </p>
              ) : (
                <ul className="grid animate-fade-in px-5 pb-2 sm:grid-cols-2 sm:gap-x-10 sm:px-6">
                  {audit.map((entry) => (
                    <AuditRow key={entry.id} time={relativeTime(entry.createdAt)}>
                      {entry.eventType}
                    </AuditRow>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

/** A time-of-day greeting for the header, from the browser's clock. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The tinted tile behind an icon, by meaning. Neutral uses the brand accent. */
const ICON_TILE: Record<StatusTone, string> = {
  neutral: 'bg-accent/10 text-accent',
  running: 'bg-state-running/10 text-state-running',
  waiting: 'bg-state-waiting/10 text-state-waiting',
  success: 'bg-state-success/10 text-state-success',
  failure: 'bg-state-failure/10 text-state-failure',
  idle: 'bg-surface-overlay text-content-subtle',
};

/**
 * One block of the overview: a card with a titled header, separated from its
 * content by a hairline. `highlight` gives the card a waiting-coloured border,
 * for the approvals block when something is waiting.
 */
function Card({
  title,
  icon: Icon,
  tone,
  count,
  action,
  highlight = false,
  className = '',
  children,
}: {
  title: string;
  icon: LucideIcon;
  tone: StatusTone;
  count?: number;
  action?: ReactNode;
  highlight?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`overflow-hidden rounded-card border bg-surface-raised ${
        highlight ? 'border-state-waiting/40' : 'border-surface-border'
      } ${className}`}
    >
      <div className="flex items-center gap-3 border-b border-surface-border px-5 py-4 sm:px-6">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${ICON_TILE[tone]}`}
          aria-hidden="true"
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-headline text-content">{title}</h2>
        {count !== undefined && count > 0 ? (
          <span className="rounded-full bg-state-waiting/10 px-2.5 py-0.5 text-meta font-semibold tabular-nums text-state-waiting">
            {count}
          </span>
        ) : null}
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * One figure in the summary, on its own card. The number carries the weight;
 * the icon tile says what kind of figure it is; the hint says what it counts.
 */
function Metric({
  label,
  hint,
  value,
  icon: Icon,
  tone,
  busy,
  highlight = false,
}: {
  label: string;
  hint: string;
  value: number;
  icon: LucideIcon;
  tone: StatusTone;
  busy: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-card border bg-surface-raised p-4 sm:p-5 ${
        highlight ? 'border-state-waiting/40' : 'border-surface-border'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <dt className="text-callout font-medium text-content-muted">{label}</dt>
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${ICON_TILE[tone]}`}
          aria-hidden="true"
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      <dd className="mt-2">
        {busy ? (
          <Skeleton className="h-9 w-12" />
        ) : (
          <span
            className={`block animate-fade-in text-display-sm tabular-nums ${
              highlight ? 'text-state-waiting' : value > 0 ? 'text-content' : 'text-content-subtle'
            }`}
          >
            {value}
          </span>
        )}
        <span className="mt-1 block text-meta text-content-subtle">{hint}</span>
      </dd>
    </div>
  );
}

/** A quiet audit entry: the event type in monospace, the time beside it. */
function AuditRow({ time, children }: { time: string; children: ReactNode }) {
  return (
    <li className="flex items-baseline justify-between gap-4 border-b border-surface-border/70 py-3">
      <span className="mono-meta min-w-0 truncate text-content-muted">{children}</span>
      <span className="shrink-0 text-meta text-content-subtle">{time}</span>
    </li>
  );
}
