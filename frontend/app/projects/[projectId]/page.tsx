'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert } from '@/components/ui/alert';
import { PROJECT_TYPE_LABELS, humanise, relativeTime } from '@/lib/format';
import type { ProjectDetail } from '@/lib/types';

export default function ProjectDetailPage() {
  const { loading, user } = useRequireAuth();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProject(await api.projects.get(projectId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The project could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !user) return <PageLoading />;

  if (error) {
    return (
      <AppShell>
        <div className="mx-auto max-w-3xl px-5 py-10">
          <Alert tone="error" title="Project unavailable">
            {error}
          </Alert>
        </div>
      </AppShell>
    );
  }

  if (!project) return <PageLoading label="Loading project" />;

  const grantedPermissions = Object.entries(project.agentPermissions);

  return (
    <AppShell>
      <div className="mx-auto max-w-[1600px] px-5 py-7">
        <nav className="mb-4 flex items-center gap-1.5 text-2xs text-content-subtle">
          <Link href="/projects" className="hover:text-content">
            Projects
          </Link>
          <span>/</span>
          <span className="text-content-muted">{project.name}</span>
        </nav>

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-lg font-semibold tracking-tight">{project.name}</h1>
              <span className="rounded border border-surface-border px-1.5 py-0.5 text-2xs text-content-subtle">
                {PROJECT_TYPE_LABELS[project.projectType] ?? project.projectType}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-content-muted">
              {project.description ?? 'No description.'}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href={`/projects/${project.id}/settings`} className="btn-secondary">
              Settings
            </Link>
            <Link href={`/projects/${project.id}/agent`} className="btn-primary">
              Open agent workspace
            </Link>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <section className="panel">
              <div className="panel-header">
                <h2 className="panel-title">Recent tasks</h2>
                <Link
                  href={`/projects/${project.id}/agent`}
                  className="text-2xs text-accent hover:underline"
                >
                  Open workspace
                </Link>
              </div>
              {project.recentTasks.length === 0 ? (
                <EmptyState
                  title="No tasks yet"
                  description="Open the agent workspace and describe the change you want in plain language."
                  action={
                    <Link href={`/projects/${project.id}/agent`} className="btn-primary">
                      Open agent workspace
                    </Link>
                  }
                />
              ) : (
                <ul className="divide-y divide-surface-border">
                  {project.recentTasks.map((task) => (
                    <li key={task.id}>
                      <Link
                        href={`/projects/${project.id}/agent?task=${task.id}`}
                        className="block px-4 py-3 transition-colors hover:bg-surface-overlay"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="line-clamp-2 text-xs leading-relaxed">{task.prompt}</p>
                          <StatusBadge status={task.status} className="shrink-0" />
                        </div>
                        <p className="mt-1.5 font-mono text-2xs text-content-subtle">
                          {task.reference}
                          {task.branch ? ` · ${task.branch}` : ''} ·{' '}
                          {relativeTime(task.createdAt)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {project.memory ? (
              <section className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">What the agent found in the repository</h2>
                  <span className="text-2xs text-content-subtle">
                    Analysed {relativeTime(project.memory.updatedAt)}
                  </span>
                </div>

                <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
                  <MemoryFact
                    label="Odoo version"
                    value={project.memory.detectedOdooVersion ?? 'Not determined'}
                    note={
                      project.memory.detectedOdooVersion &&
                      project.odooVersion &&
                      project.memory.detectedOdooVersion !== project.odooVersion
                        ? `The project is set to ${project.odooVersion}`
                        : undefined
                    }
                  />
                  <MemoryFact
                    label="Python version"
                    value={project.memory.pythonVersion ?? 'Not declared'}
                  />
                  <MemoryFact
                    label="Files"
                    value={String(project.memory.repositoryStructure?.totalFiles ?? 0)}
                  />
                </div>

                {project.memory.modules.length > 0 ? (
                  <div className="border-t border-surface-border px-4 py-4">
                    <p className="panel-title mb-2">
                      Modules ({project.memory.modules.length})
                    </p>
                    <ul className="space-y-1.5">
                      {project.memory.modules.map((module) => (
                        <li
                          key={module.path}
                          className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
                        >
                          <span className="min-w-0">
                            <span className="font-mono text-2xs text-content">
                              {module.technicalName}
                            </span>
                            {module.name ? (
                              <span className="ml-2 text-content-muted">{module.name}</span>
                            ) : null}
                            {module.isApplication ? (
                              <span className="ml-2 rounded border border-surface-border px-1 py-0.5 text-2xs text-content-subtle">
                                application
                              </span>
                            ) : null}
                            {module.installable === false ? (
                              <span className="ml-2 text-2xs text-state-waiting">
                                not installable
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 font-mono text-2xs text-content-subtle">
                            {module.version ?? 'no version'} · {module.fileCount} files
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {project.memory.notes.length > 0 ? (
                  <div className="border-t border-surface-border px-4 py-4">
                    <p className="panel-title mb-2">Observations</p>
                    <ul className="space-y-1">
                      {project.memory.notes.map((note) => (
                        <li key={note} className="text-2xs leading-relaxed text-state-waiting">
                          {note}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="border-t border-surface-border px-4 py-3">
                  <p className="text-2xs leading-relaxed text-content-subtle">
                    Read from the repository&rsquo;s own manifests and file names. Manifests are
                    parsed as text and never executed, and this record holds technical facts only -
                    never customer data.
                  </p>
                </div>
              </section>
            ) : null}

            {project.specification ? (
              <section className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Project specification</h2>
                  <span className="text-2xs text-content-subtle">
                    Version {project.specificationVersion}
                  </span>
                </div>
                <div className="space-y-4 px-4 py-4">
                  <p className="text-xs leading-relaxed text-content-muted">
                    {project.specification.description}
                  </p>
                  <div>
                    <p className="panel-title mb-2">Requirements</p>
                    <ul className="space-y-1.5">
                      {project.specification.requirements.map((requirement) => (
                        <li key={requirement.id} className="flex gap-2.5 text-xs">
                          <span className="font-mono text-2xs text-content-subtle">
                            {requirement.id}
                          </span>
                          <span>
                            {requirement.title}
                            {requirement.detail ? (
                              <span className="text-content-subtle"> — {requirement.detail}</span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <p className="text-2xs text-content-subtle">
                    Target environment: {project.specification.deployment.environment}
                  </p>
                </div>
              </section>
            ) : null}
          </div>

          <div className="space-y-5">
            <section className="panel">
              <div className="panel-header">
                <h2 className="panel-title">Project</h2>
              </div>
              <dl className="divide-y divide-surface-border text-xs">
                <DetailRow label="Odoo version" value={project.odooVersion ?? 'Not set'} />
                <DetailRow label="Default branch" value={project.defaultBranch} mono />
                <DetailRow
                  label="Repository"
                  value={project.repositoryUrl ?? 'None connected'}
                  mono
                />
                <DetailRow label="Your role" value={humanise(project.viewerRole)} />
                <DetailRow label="Created" value={relativeTime(project.createdAt)} />
              </dl>
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2 className="panel-title">Connections</h2>
              </div>
              {project.connections.length === 0 ? (
                <p className="px-4 py-5 text-xs text-content-muted">
                  No connection configured. The agent cannot reach a repository until one exists.
                </p>
              ) : (
                <ul className="divide-y divide-surface-border">
                  {project.connections.map((connection) => (
                    <li key={connection.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">
                          {humanise(connection.connectionType)}
                        </span>
                        <span
                          className={`text-2xs ${
                            connection.status === 'connected'
                              ? 'text-state-success'
                              : connection.status === 'error'
                                ? 'text-state-failure'
                                : 'text-content-subtle'
                          }`}
                        >
                          {humanise(connection.status)}
                        </span>
                      </div>
                      <p className="mt-1 text-2xs text-content-subtle">
                        {connection.hasCredentials
                          ? 'Credential held (encrypted, never returned)'
                          : 'No credential held'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2 className="panel-title">Agent permissions</h2>
                <Link
                  href={`/projects/${project.id}/settings`}
                  className="text-2xs text-accent hover:underline"
                >
                  Change
                </Link>
              </div>
              <ul className="divide-y divide-surface-border">
                {grantedPermissions.map(([permission, granted]) => (
                  <li
                    key={permission}
                    className="flex items-center justify-between px-4 py-2 text-xs"
                  >
                    <span className="font-mono text-2xs text-content-muted">{permission}</span>
                    <span
                      className={
                        granted ? 'text-2xs text-state-success' : 'text-2xs text-content-subtle'
                      }
                    >
                      {granted ? 'granted' : 'denied'}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="border-t border-surface-border px-4 py-3">
                <p className="text-2xs leading-relaxed text-content-subtle">
                  Database export and backup are never grantable. Production database records are
                  denied by default and are not read, transmitted or stored.
                </p>
              </div>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function MemoryFact({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <p className="panel-title">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
      {note ? <p className="mt-0.5 text-2xs text-state-waiting">{note}</p> : null}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5">
      <dt className="shrink-0 text-content-subtle">{label}</dt>
      <dd className={`min-w-0 truncate text-right ${mono ? 'font-mono text-2xs' : ''}`}>{value}</dd>
    </div>
  );
}
