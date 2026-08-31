'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PROJECT_TYPE_LABELS, humanise, isActiveStatus, relativeTime } from '@/lib/format';
import type {
  AuditLogEntry,
  PendingApprovalSummary,
  ProjectSummary,
  TaskSummary,
} from '@/lib/types';

/**
 * The dashboard answers three questions in order of urgency: what is waiting for
 * me, what is running, and what has recently happened. Anything that does not
 * answer one of those is not on this page.
 */
export default function DashboardPage() {
  const { loading, user, organization } = useRequireAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [approvals, setApprovals] = useState<PendingApprovalSummary[]>([]);
  const [tasks, setTasks] = useState<(TaskSummary & { projectName: string })[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [busy, setBusy] = useState(true);

  const organizationId = organization?.organizationId ?? null;
  const canReadAudit = organization?.role === 'owner' || organization?.role === 'admin';

  const load = useCallback(async () => {
    if (!organizationId) return;
    setBusy(true);
    try {
      const [projectList, pending] = await Promise.all([
        api.projects.list(organizationId),
        api.approvals.pending(organizationId),
      ]);

      setProjects(projectList);
      setApprovals(pending);

      // Recent tasks are gathered from the projects that have any, newest first.
      const withTasks = projectList.filter((project) => project.taskCount > 0).slice(0, 8);
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
        setAudit(await api.organizations.auditLogs(organizationId, 12));
      }
    } finally {
      setBusy(false);
    }
  }, [organizationId, canReadAudit]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !user) return <PageLoading label="Loading your session" />;

  const activeTasks = tasks.filter((task) => isActiveStatus(task.status));

  return (
    <AppShell>
      <div className="mx-auto max-w-[1600px] px-5 py-7">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
            <p className="mt-0.5 text-xs text-content-muted">
              {organization?.organizationName ?? 'No organisation'}
            </p>
          </div>
          <Link href="/projects/new" className="btn-primary">
            New project
          </Link>
        </div>

        <div className="mb-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Projects" value={projects.length} />
          <MetricCard label="Active tasks" value={activeTasks.length} tone="running" />
          <MetricCard label="Awaiting approval" value={approvals.length} tone="waiting" />
          <MetricCard
            label="Tasks completed"
            value={tasks.filter((task) => task.status === 'completed').length}
            tone="success"
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <section className="panel lg:col-span-2">
            <div className="panel-header">
              <h2 className="panel-title">Awaiting your approval</h2>
              <span className="text-2xs text-content-subtle">{approvals.length}</span>
            </div>

            {busy ? (
              <p className="px-4 py-8 text-center text-xs text-content-subtle">Loading</p>
            ) : approvals.length === 0 ? (
              <EmptyState
                title="Nothing is waiting for you"
                description="When the agent reaches an action that requires human authorisation, it pauses and the request appears here."
              />
            ) : (
              <ul className="divide-y divide-surface-border">
                {approvals.map((approval) => (
                  <li key={approval.id} className="px-4 py-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{humanise(approval.action)}</p>
                        <p className="mt-0.5 text-xs text-content-muted">
                          {approval.requiredReason}
                        </p>
                        <p className="mt-1.5 font-mono text-2xs text-content-subtle">
                          {approval.projectName} · {approval.taskReference} ·{' '}
                          {relativeTime(approval.requestedAt)}
                        </p>
                      </div>
                      <Link
                        href={`/projects/${approval.projectId}/agent?task=${approval.taskId}`}
                        className="btn-secondary shrink-0 py-1.5 text-xs"
                      >
                        Review
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Recent tasks</h2>
            </div>
            {tasks.length === 0 ? (
              <EmptyState
                title="No tasks yet"
                description="Submit a prompt in a project's agent workspace to create the first one."
              />
            ) : (
              <ul className="divide-y divide-surface-border">
                {tasks.map((task) => (
                  <li key={task.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-xs leading-relaxed text-content">
                        {task.prompt}
                      </p>
                      <StatusBadge status={task.status} className="shrink-0" />
                    </div>
                    <p className="mt-1.5 font-mono text-2xs text-content-subtle">
                      {task.projectName} · {task.reference} · {relativeTime(task.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <section className="panel lg:col-span-2">
            <div className="panel-header">
              <h2 className="panel-title">Projects</h2>
              <Link href="/projects" className="text-2xs text-accent hover:underline">
                View all
              </Link>
            </div>
            {projects.length === 0 ? (
              <EmptyState
                title="No projects yet"
                description="Connect an existing Odoo repository, or have the agent specify a new project for you."
                action={
                  <Link href="/projects/new" className="btn-primary">
                    New project
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-surface-border">
                {projects.slice(0, 6).map((project) => (
                  <li key={project.id}>
                    <Link
                      href={`/projects/${project.id}`}
                      className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-overlay"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{project.name}</p>
                        <p className="mt-0.5 text-2xs text-content-subtle">
                          {PROJECT_TYPE_LABELS[project.projectType] ?? project.projectType}
                          {project.odooVersion ? ` · Odoo ${project.odooVersion}` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right text-2xs text-content-subtle">
                        <p>{project.taskCount} tasks</p>
                        {project.openTaskCount > 0 ? (
                          <p className="text-state-running">{project.openTaskCount} open</p>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canReadAudit ? (
            <section className="panel">
              <div className="panel-header">
                <h2 className="panel-title">Audit trail</h2>
              </div>
              {audit.length === 0 ? (
                <EmptyState
                  title="No entries yet"
                  description="Actions are recorded as they occur."
                />
              ) : (
                <ul className="divide-y divide-surface-border">
                  {audit.map((entry) => (
                    <li key={entry.id} className="px-4 py-2.5">
                      <p className="font-mono text-2xs text-content">{entry.eventType}</p>
                      <p className="mt-0.5 text-2xs text-content-subtle">
                        {relativeTime(entry.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'running' | 'waiting' | 'success';
}) {
  const colour =
    tone === 'running'
      ? 'text-state-running'
      : tone === 'waiting'
        ? 'text-state-waiting'
        : tone === 'success'
          ? 'text-state-success'
          : 'text-content';

  return (
    <div className="panel px-4 py-3.5">
      <p className="panel-title">{label}</p>
      <p
        className={`mt-1.5 text-2xl font-semibold tabular-nums ${
          value > 0 ? colour : 'text-content-subtle'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
