'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, FolderGit2, ListChecks, Lock } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageHeader } from '@/components/ui/page';
import { Section } from '@/components/ui/section';
import { PageLoading } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusDot } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { PROJECT_TYPE_LABELS, humanise, isActiveStatus, relativeTime } from '@/lib/format';
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
 * The approvals list is the page's primary content: when anything is waiting
 * it sits directly under the summary at full width; when nothing is, it shrinks
 * to a single quiet line so the page does not shout about an absence.
 */
export default function DashboardPage() {
  const { loading, user } = useRequireAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [approvals, setApprovals] = useState<PendingApprovalSummary[]>([]);
  const [tasks, setTasks] = useState<(TaskSummary & { projectName: string })[]>([]);
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
          return list.map((task) => ({ ...task, projectName: project.name }));
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
  const firstName = user.name.split(/\s+/).filter(Boolean)[0] ?? user.name;

  return (
    <AppShell>
      <div className="page">
        <PageHeader
          title="Overview"
          description={`${greeting()}, ${firstName}. Here is what needs you and what is running.`}
          meta={<span className="meta">{USER_REGION_LABELS[user.region]} region</span>}
          actions={
            <Link href="/projects/new" className="btn-primary">
              New project
            </Link>
          }
        />

        <div className="space-y-12 sm:space-y-16">
          {/* Summary: large numbers, small labels, no boxes. Only "awaiting
              approval" takes a colour, and only when something is waiting. */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4">
            <Metric label="Projects" value={projects.length} busy={busy} />
            <Metric label="Active tasks" value={activeTasks.length} busy={busy} />
            <Metric
              label="Awaiting approval"
              value={approvals.length}
              busy={busy}
              emphasis={approvals.length > 0}
            />
            <Metric
              label="Tasks completed"
              value={tasks.filter((task) => task.status === 'completed').length}
              busy={busy}
            />
          </dl>

          {busy ? (
            <Section title="Awaiting your approval">
              <SkeletonRows rows={2} className="-mx-4" />
            </Section>
          ) : approvals.length === 0 ? (
            <p className="flex animate-fade-in items-start gap-3 text-callout text-content-muted">
              <CheckCircle2
                className="mt-0.5 h-[18px] w-[18px] shrink-0 text-state-success"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span>
                <span className="font-medium text-content">Nothing is waiting for you.</span>{' '}
                <span className="text-content-subtle">
                  When the agent reaches an action that needs your authorisation, it pauses and
                  the request appears here.
                </span>
              </span>
            </p>
          ) : (
            <Section
              title="Awaiting your approval"
              description="The agent has paused on each of these until someone authorises it."
              actions={<span className="meta tabular-nums">{approvals.length}</span>}
            >
              <ul className="-mx-4 animate-fade-in space-y-1">
                {approvals.map((approval) => (
                  <li key={approval.id} className="list-row items-start">
                    <span
                      className="mt-2 h-2 w-2 shrink-0 rounded-full bg-state-waiting"
                      aria-hidden="true"
                    />
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
                      className="btn-secondary btn-sm shrink-0"
                    >
                      Review
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <div className="grid gap-12 lg:grid-cols-5 lg:gap-10">
            <Section title="Recent tasks" size="small" className="lg:col-span-3">
              {busy ? (
                <SkeletonRows rows={4} className="-mx-4" />
              ) : tasks.length === 0 ? (
                <EmptyState
                  compact
                  icon={ListChecks}
                  title="No tasks yet"
                  description="Submit a prompt in a project's agent workspace to create the first one."
                />
              ) : (
                <ul className="-mx-4 animate-fade-in">
                  {tasks.map((task) => (
                    <li key={task.id} className="flex items-start gap-4 rounded-xl px-4 py-3.5">
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-callout text-content">{task.prompt}</p>
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
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              title="Projects"
              size="small"
              className="lg:col-span-2"
              actions={
                <Link href="/projects" className="link-quiet text-callout">
                  View all
                </Link>
              }
            >
              {busy ? (
                <SkeletonRows rows={3} className="-mx-4" />
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
                <ul className="-mx-4 animate-fade-in space-y-1">
                  {projects.slice(0, 6).map((project) => {
                    const body = (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body font-medium text-content">
                            {project.name}
                          </p>
                          <p className="mt-0.5 truncate text-meta text-content-subtle">
                            {PROJECT_TYPE_LABELS[project.projectType] ?? project.projectType}
                            {project.odooVersion ? ` · Odoo ${project.odooVersion}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1 text-meta text-content-subtle">
                          {project.hasAccess ? (
                            <span className="tabular-nums">{project.taskCount ?? 0} tasks</span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <Lock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                              Locked
                            </span>
                          )}
                          {(project.openTaskCount ?? 0) > 0 ? (
                            <StatusDot tone="running" size="small">
                              {project.openTaskCount} open
                            </StatusDot>
                          ) : null}
                        </div>
                      </>
                    );
                    return (
                      <li key={project.id}>
                        {project.hasAccess ? (
                          <Link href={`/projects/${project.id}`} className="list-row">
                            {body}
                          </Link>
                        ) : (
                          /* Listed, not linked: the link would only lead to a 403.
                             Asking for access happens on /projects (ADR-043). */
                          <div className="flex items-center gap-4 rounded-xl px-4 py-3.5 opacity-60">
                            {body}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </div>

          {canReadAudit ? (
            <Section
              title="Audit trail"
              description="The latest recorded actions across the platform."
              size="small"
              divided
            >
              {busy ? (
                <SkeletonRows rows={3} className="-mx-4" />
              ) : audit.length === 0 ? (
                <p className="text-callout text-content-subtle">
                  No entries yet. Actions are recorded as they occur.
                </p>
              ) : (
                <ul className="grid animate-fade-in gap-x-10 sm:grid-cols-2">
                  {audit.map((entry) => (
                    <AuditRow key={entry.id} time={relativeTime(entry.createdAt)}>
                      {entry.eventType}
                    </AuditRow>
                  ))}
                </ul>
              )}
            </Section>
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

/**
 * One figure in the summary. The number carries the weight and the label
 * recedes; colour is reserved for a figure that asks something of the reader.
 */
function Metric({
  label,
  value,
  busy,
  emphasis = false,
}: {
  label: string;
  value: number;
  busy: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-content-subtle">{label}</dt>
      <dd className="mt-1.5">
        {busy ? (
          <Skeleton className="h-9 w-12" />
        ) : (
          <span
            className={`block animate-fade-in text-display-sm tabular-nums sm:text-display ${
              emphasis ? 'text-state-waiting' : value > 0 ? 'text-content' : 'text-content-subtle'
            }`}
          >
            {value}
          </span>
        )}
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
