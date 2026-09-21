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
import type { BackupSummary, ProjectDetail } from '@/lib/types';

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

  /**
   * ADR-056: a queued selective install is the one project state that changes
   * without anyone doing anything, so the page watches it.
   *
   * Three seconds: fast enough that the transition to `provisioned` reads as
   * the page having noticed rather than the person having refreshed, slow
   * enough that a multi-minute install is not thousands of requests. The timer
   * stops as soon as the status leaves `pending`, because a finished install
   * never changes again on its own.
   */
  useEffect(() => {
    if (project?.provisioning.status !== 'pending') return;

    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [project?.provisioning.status, load]);

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
            {project.provisioning.status !== 'none' ? (
              <InstancePanel
                projectId={project.id}
                provisioning={project.provisioning}
                restart={project.restart}
                repositoryUrl={project.repositoryUrl}
                isAdmin={user.isAdmin}
              />
            ) : null}

            <section className="panel">
              <div className="panel-header">
                <h2 className="panel-title">Project</h2>
              </div>
              <dl className="divide-y divide-surface-border text-xs">
                <DetailRow label="Odoo version" value={project.odooVersion ?? 'Not set'} />
                <DetailRow
                  label="Odoo edition"
                  value={project.odooEdition === 'community' ? 'Community' : 'Enterprise'}
                />
                <DetailRow label="Default branch" value={project.defaultBranch} mono />
                <DetailRow
                  label="Repository"
                  value={project.repositoryUrl ?? 'None connected'}
                  mono
                />
                <DetailRow label="Your access" value={humanise(project.accessReason)} />
                <DetailRow label="Created" value={relativeTime(project.createdAt)} />
                {project.link.projectUrl ? (
                  <>
                    <DetailRow label="Linked instance" value={project.link.projectUrl} mono />
                    <DetailRow
                      label="Linked database"
                      value={project.link.database ?? 'Not set'}
                      mono
                    />
                    <DetailRow
                      label="Linked instance kind"
                      value={project.link.isOdoosh ? 'Odoo.sh' : 'On-premise'}
                    />
                  </>
                ) : null}
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

/**
 * The provisioned instance's own connection details (ADR-039, ADR-040): URL,
 * database, status, and a "reveal" control for the master password gated to
 * admin/owner (enforced by the API; the button is simply not shown to anyone
 * else, since a 403 from clicking it would be a confusing dead end).
 */
function InstancePanel({
  projectId,
  provisioning,
  restart,
  repositoryUrl,
  isAdmin,
}: {
  projectId: string;
  provisioning: import('@/lib/types').ProjectProvisioningInfo;
  restart: import('@/lib/types').ProjectRestartInfo;
  repositoryUrl: string | null;
  isAdmin: boolean;
}) {
  const canReveal = isAdmin;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  const reveal = useCallback(async () => {
    setRevealing(true);
    setRevealError(null);
    try {
      const { masterPassword } = await api.projects.revealMasterPassword(projectId);
      setRevealed(masterPassword);
    } catch (caught) {
      setRevealError(
        caught instanceof ApiError ? caught.message : 'The master password could not be revealed.',
      );
    } finally {
      setRevealing(false);
    }
  }, [projectId]);

  const statusTone =
    provisioning.status === 'provisioned'
      ? 'text-state-success'
      : provisioning.status === 'failed'
        ? 'text-state-failure'
        : 'text-state-waiting';

  /**
   * Deploy: put the project's own branch onto the running instance (ADR-049).
   *
   * Shown only to an admin on a provisioned instance, which is the same gate the
   * API applies — the button is not the guard, but offering it to someone the API
   * will refuse is a dead end that reads like a bug.
   */
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployed, setDeployed] = useState<{ commit: string | null; branch: string | null } | null>(
    null,
  );

  const deploy = useCallback(async () => {
    setDeploying(true);
    setDeployError(null);
    setDeployed(null);
    try {
      const result = await api.projects.pull(projectId);
      if (result.ok) {
        setDeployed({ commit: result.commit, branch: result.branch });
      } else {
        // The API reports a refusal as a normal result, not a throw: what to say
        // is the script's own message, which names the cause.
        setDeployError(result.message);
      }
    } catch (caught) {
      setDeployError(caught instanceof ApiError ? caught.message : 'The deploy could not be run.');
    } finally {
      setDeploying(false);
    }
  }, [projectId]);

  /**
   * Ship to production (ADR-057): promote staging onto main, then bring the
   * instance onto main and serve it.
   *
   * Two separate routes, sequenced here because that is the common case the ADR
   * calls out: "get what I just promted on staging actually live". Merge first
   * and only restart if it landed — restarting onto main after a merge that
   * failed would deploy whatever main already held, which is not what pressing
   * this button means.
   */
  const [shipping, setShipping] = useState(false);
  const [shipError, setShipError] = useState<string | null>(null);
  const [shipStage, setShipStage] = useState<'idle' | 'merging' | 'restarting' | 'queued'>('idle');
  const [merged, setMerged] = useState<string | null>(null);

  const shipToProduction = useCallback(async () => {
    setShipping(true);
    setShipError(null);
    setMerged(null);
    try {
      setShipStage('merging');
      const merge = await api.projects.mergeToMain(projectId);
      if (!merge.ok) {
        setShipError(merge.message);
        setShipStage('idle');
        return;
      }
      setMerged(merge.commit);

      // Queued, not awaited: the upgrade can outlast a request. The restart
      // status the page already polls reports the outcome.
      setShipStage('restarting');
      await api.projects.restart(projectId, 'main');
      setShipStage('queued');
    } catch (caught) {
      setShipError(caught instanceof ApiError ? caught.message : 'The change could not be shipped.');
      setShipStage('idle');
    } finally {
      setShipping(false);
    }
  }, [projectId]);

  // A restart runs on the worker, so "in flight" is the project row's own
  // status plus the moment between the merge landing and the job being queued.
  const restarting = restart.status === 'pending' || shipStage === 'queued';

  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="panel-title">Instance</h2>
        <span className={`text-2xs ${statusTone}`}>{humanise(provisioning.status)}</span>
      </div>

      {provisioning.status === 'failed' && provisioning.error ? (
        <div className="border-b border-surface-border px-4 py-3">
          <Alert tone="error" title="Provisioning failed">
            {provisioning.error}
          </Alert>
        </div>
      ) : null}

      {provisioning.status === 'pending' ? (
        <div className="border-b border-surface-border px-4 py-3">
          <Alert tone="info" title="Provisioning in progress">
            The selected modules are being installed in the background. This page updates
            automatically once the instance is ready.
          </Alert>
        </div>
      ) : null}

      <dl className="divide-y divide-surface-border text-xs">
        <DetailRow
          label="URL"
          value={provisioning.url ?? 'Not provisioned'}
          mono
        />
        <DetailRow label="Database" value={provisioning.databaseName ?? 'None'} mono />
        <DetailRow
          label="HTTPS"
          value={
            provisioning.https.status === 'issued'
              ? 'Active'
              : provisioning.https.status === 'failed'
                ? `Failed${provisioning.https.error ? ` — ${provisioning.https.error}` : ''}`
                : provisioning.https.status === 'pending'
                  ? 'Pending'
                  : 'Not issued (plain HTTP)'
          }
        />
        {provisioning.provisionedAt ? (
          <DetailRow label="Provisioned" value={relativeTime(provisioning.provisionedAt)} />
        ) : null}
      </dl>

      {canReveal && provisioning.status === 'provisioned' ? (
        <div className="space-y-2 border-t border-surface-border px-4 py-3">
          <p className="panel-title">Repository</p>
          <p className="text-2xs leading-relaxed text-content-subtle">
            Run this project&apos;s branch onto the instance. The server resets to the tip of
            the branch, so anything that is only on the server and not in the repository is
            replaced.
          </p>
          <button
            type="button"
            onClick={() => void deploy()}
            disabled={deploying}
            className="btn-secondary text-2xs"
          >
            {deploying ? 'Deploying…' : 'Deploy latest'}
          </button>
          {deployed ? (
            <p className="text-2xs leading-relaxed text-state-success">
              Deployed {deployed.branch ?? 'the branch'}
              {deployed.commit ? ` at ${deployed.commit.slice(0, 8)}` : ''}.
            </p>
          ) : null}
          {deployError ? (
            <p className="text-2xs leading-relaxed text-state-failure">{deployError}</p>
          ) : null}
        </div>
      ) : null}

      {canReveal && repositoryUrl && provisioning.status === 'provisioned' ? (
        <div className="space-y-2 border-t border-surface-border px-4 py-3">
          <p className="panel-title">Ship to production</p>
          <p className="text-2xs leading-relaxed text-content-subtle">
            Merges this project&apos;s staging branch onto main (conflicts resolve in
            staging&apos;s favour), then upgrades and restarts the instance onto it. The
            instance is briefly stopped while the upgrade runs.
          </p>
          <button
            type="button"
            onClick={() => void shipToProduction()}
            disabled={shipping || restarting}
            className="btn-primary text-2xs"
          >
            {shipStage === 'merging'
              ? 'Merging staging into main…'
              : shipStage === 'restarting' || restarting
                ? 'Upgrading and restarting…'
                : 'Ship staging to production'}
          </button>
          {merged ? (
            <p className="text-2xs leading-relaxed text-state-success">
              Merged into main at {merged.slice(0, 8)}.
              {shipStage === 'queued' ? ' Restart queued.' : ''}
            </p>
          ) : null}
          {shipError ? (
            <p className="text-2xs leading-relaxed text-state-failure">{shipError}</p>
          ) : null}
          {restart.status !== 'none' ? (
            <p
              className={`text-2xs leading-relaxed ${
                restart.status === 'failed' ? 'text-state-failure' : 'text-content-subtle'
              }`}
            >
              Last restart: {humanise(restart.status)}
              {restart.branch ? ` (${restart.branch})` : ''}
              {restart.commit ? ` @ ${restart.commit.slice(0, 8)}` : ''}
              {restart.error ? ` — ${restart.error}` : ''}
              {restart.restartedAt ? ` · ${relativeTime(restart.restartedAt)}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}

      <BackupsPanel projectId={projectId} provisioned={provisioning.status === 'provisioned'} />
      <ModulesPanel projectId={projectId} provisioned={provisioning.status === 'provisioned'} />

      {provisioning.hasMasterPassword ? (
        <div className="border-t border-surface-border px-4 py-3">
          <p className="panel-title mb-2">Master password</p>
          {revealed ? (
            <div className="space-y-2">
              <code className="block break-all rounded border border-surface-border bg-surface-overlay px-2 py-1.5 font-mono text-2xs">
                {revealed}
              </code>
              <p className="text-2xs leading-relaxed text-content-subtle">
                Store this somewhere safe. It will not be shown here again without another reveal.
              </p>
            </div>
          ) : canReveal ? (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void reveal()}
                disabled={revealing}
                className="btn-secondary text-2xs"
              >
                {revealing ? 'Revealing…' : 'Reveal master password'}
              </button>
              {revealError ? (
                <p className="text-2xs leading-relaxed text-state-failure">{revealError}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-2xs leading-relaxed text-content-subtle">
              Held, encrypted. Only an organisation admin or owner can reveal it.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The per-client backups (ADR-054): a restorable snapshot of the database, the
 * filestore and the addons repository, taken before a push onto a staging (or
 * main-named) branch and on request here. The snapshot itself lives under
 * /opt/odoo/backups on the host and is restorable by an operator without this
 * platform; this panel shows what exists and asks for one more.
 */
function BackupsPanel({ projectId, provisioned }: { projectId: string; provisioned: boolean }) {
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [available, setAvailable] = useState(true);
  const [availabilityReason, setAvailabilityReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.projects.backups(projectId);
      setBackups(result.backups);
      setAvailable(result.available);
      setAvailabilityReason(result.reason);
    } catch {
      setBackups([]);
    }
  }, [projectId]);

  useEffect(() => {
    if (!provisioned) return;
    void load();
  }, [load, provisioned]);

  if (!provisioned) return null;

  const runBackup = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.projects.runBackup(projectId);
      setNotice(result.message);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The backup could not be run.');
    } finally {
      setBusy(false);
    }
  };

  const latest = backups[0] ?? null;

  return (
    <div className="space-y-2 border-t border-surface-border px-4 py-3">
      <p className="panel-title">Backups</p>
      <p className="text-2xs leading-relaxed text-content-subtle">
        A restore point of this instance&apos;s database, filestore and addons repository, kept on
        the host under /opt/odoo/backups. One is taken automatically before a push onto a staging
        or main branch; this button takes one now.
      </p>

      {latest ? (
        <ul className="divide-y divide-surface-border text-2xs">
          {backups.slice(0, 3).map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="font-mono">{row.backupId ?? row.createdAt}</span>
              <span
                className={
                  row.status === 'completed'
                    ? 'text-state-success'
                    : row.status === 'failed'
                      ? 'text-state-failure'
                      : 'text-state-waiting'
                }
              >
                {row.status}
                {row.reason === 'pre_push' ? ' · before a push' : ''}
                {row.sizeBytes ? ` · ${Math.round(row.sizeBytes / 1024 / 1024)} MB` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-2xs text-content-subtle">No backups yet.</p>
      )}

      {available ? (
        <button
          type="button"
          onClick={() => void runBackup()}
          disabled={busy}
          className="btn-secondary text-2xs"
        >
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
      ) : (
        <p className="text-2xs leading-relaxed text-content-subtle">
          {availabilityReason ?? 'Backup is not enabled on this deployment.'}
        </p>
      )}

      {notice ? <p className="text-2xs leading-relaxed text-state-success">{notice}</p> : null}
      {error ? <p className="text-2xs leading-relaxed text-state-failure">{error}</p> : null}
    </div>
  );
}

/**
 * What is actually installed in the instance (ADR-056) — as opposed to what
 * the module picker asked for at creation, which is only ever a request. Reads
 * fresh on mount, once (no polling: unlike provisioning status this does not
 * change on its own between visits, and the button is right there to ask
 * again after installing something new).
 */
function ModulesPanel({ projectId, provisioned }: { projectId: string; provisioned: boolean }) {
  const [modules, setModules] = useState<{ name: string; state: string }[]>([]);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.projects.installedModules(projectId);
      setModules(result.modules);
      setAvailable(result.available);
      setReason(result.reason);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not read installed modules.');
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [projectId]);

  if (!provisioned) return null;

  const installed = modules.filter((module) => module.state === 'installed');

  return (
    <div className="space-y-2 border-t border-surface-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="panel-title">Installed modules</p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="btn-secondary text-2xs"
        >
          {loading ? 'Reading…' : loaded ? 'Refresh' : 'Show'}
        </button>
      </div>

      {!loaded ? (
        <p className="text-2xs leading-relaxed text-content-subtle">
          Read fresh from the instance&apos;s own database on request — not cached.
        </p>
      ) : !available ? (
        <p className="text-2xs leading-relaxed text-content-subtle">
          {reason ?? 'Reading installed modules is not enabled on this deployment.'}
        </p>
      ) : reason ? (
        <p className="text-2xs leading-relaxed text-state-failure">{reason}</p>
      ) : installed.length === 0 ? (
        <p className="text-2xs text-content-subtle">No modules reported.</p>
      ) : (
        <p className="text-2xs leading-relaxed text-content-subtle">
          {installed.length} module{installed.length === 1 ? '' : 's'} installed:{' '}
          <span className="font-mono text-content-default">
            {installed.map((module) => module.name).join(', ')}
          </span>
        </p>
      )}

      {error ? <p className="text-2xs leading-relaxed text-state-failure">{error}</p> : null}
    </div>
  );
}
