'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, GitBranch, MessageSquarePlus, Settings2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert } from '@/components/ui/alert';
import { BackLink, PageHeader } from '@/components/ui/page';
import { Section } from '@/components/ui/section';
import { Disclosure } from '@/components/ui/disclosure';
import { DetailItem, DetailList } from '@/components/ui/detail-list';
import { Skeleton, SkeletonRows, SkeletonText } from '@/components/ui/skeleton';
import { PROJECT_TYPE_LABELS, humanise, relativeTime } from '@/lib/format';
import type {
  BackupSummary,
  CheckoutStatus,
  ProjectDetail,
  ProjectProvisioningInfo,
  ProjectRestartInfo,
} from '@/lib/types';

/**
 * The instance's provisioning state, in the words a person would use. Shown
 * under the project name and again at the head of the instance section, so the
 * one thing that changes on its own is the first thing read.
 */
const INSTANCE_STATE: Record<
  ProjectProvisioningInfo['status'],
  { tone: StatusTone; label: string; pulse: boolean }
> = {
  none: { tone: 'idle', label: 'No instance', pulse: false },
  pending: { tone: 'running', label: 'Installing modules', pulse: true },
  provisioned: { tone: 'success', label: 'Instance ready', pulse: false },
  failed: { tone: 'failure', label: 'Provisioning failed', pulse: false },
};

/**
 * The project's workspace page. The name dominates, its state sits directly
 * beneath it, and the page then reads from what is happening now (the instance,
 * recent tasks) down to how the project is configured. Identifiers, long lists
 * and credentials are kept lower and behind disclosures.
 */
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
        <div className="page">
          <BackLink href="/projects" label="Projects" />
          <div className="max-w-2xl">
            <Alert tone="error" title="Project unavailable">
              {error}
            </Alert>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!project) return <ProjectDetailSkeleton />;

  const grantedPermissions = Object.entries(project.agentPermissions);
  const grantedCount = grantedPermissions.filter(([, granted]) => granted).length;
  const instance = INSTANCE_STATE[project.provisioning.status];
  const hasInstance = project.provisioning.status !== 'none';
  const workspaceHref = `/projects/${project.id}/agent`;

  return (
    <AppShell>
      <div className="page">
        <PageHeader
          back={{ href: '/projects', label: 'Projects' }}
          title={<span className="break-words">{project.name}</span>}
          description={project.description ?? undefined}
          meta={
            <>
              <StatusDot tone={instance.tone} pulse={instance.pulse} size="small">
                {instance.label}
              </StatusDot>
              <MetaFact>
                {project.odooVersion ? `Odoo ${project.odooVersion}` : 'Odoo version not set'}
              </MetaFact>
              <MetaFact>{PROJECT_TYPE_LABELS[project.projectType] ?? project.projectType}</MetaFact>
              <MetaFact className="hidden sm:inline-flex">
                <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span className="font-mono text-caption">{project.defaultBranch}</span>
              </MetaFact>
              <MetaFact className="hidden sm:inline-flex">
                Updated {relativeTime(project.updatedAt)}
              </MetaFact>
            </>
          }
          actions={
            <>
              <Link href={`/projects/${project.id}/settings`} className="btn-secondary">
                <Settings2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
                Settings
              </Link>
              <Link href={workspaceHref} className="btn-primary">
                Open workspace
              </Link>
            </>
          }
        />

        <div className="grid gap-12 lg:grid-cols-3 lg:gap-16">
          <div className="min-w-0 space-y-12 lg:col-span-2 lg:space-y-16">
            {hasInstance ? <InstanceOverview provisioning={project.provisioning} /> : null}

            <Section
              title="Recent tasks"
              actions={
                project.recentTasks.length > 0 ? (
                  <Link href={workspaceHref} className="link-quiet text-callout">
                    View all
                  </Link>
                ) : null
              }
            >
              {project.recentTasks.length === 0 ? (
                <div className="panel">
                  <EmptyState
                    compact
                    icon={MessageSquarePlus}
                    title="No tasks yet"
                    description="Open the workspace and describe the change you want in plain language."
                    action={
                      <Link href={workspaceHref} className="btn-secondary">
                        Start a task
                      </Link>
                    }
                  />
                </div>
              ) : (
                <ul className="-mx-4 space-y-0.5">
                  {project.recentTasks.map((task) => (
                    <li key={task.id}>
                      <Link
                        href={`/projects/${project.id}/agent?task=${task.id}`}
                        className="list-row items-start"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-body font-medium text-content">
                            {task.prompt}
                          </p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-content-subtle">
                            <span className="hidden font-mono text-caption sm:inline">
                              {task.reference}
                            </span>
                            {task.branch ? (
                              <span className="hidden min-w-0 truncate font-mono text-caption sm:inline">
                                {task.branch}
                              </span>
                            ) : null}
                            <span>{relativeTime(task.createdAt)}</span>
                          </p>
                        </div>
                        <StatusBadge status={task.status} className="mt-0.5 shrink-0" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {hasInstance ? (
              <InstanceOperations
                projectId={project.id}
                provisioning={project.provisioning}
                restart={project.restart}
                repositoryUrl={project.repositoryUrl}
                isAdmin={user.isAdmin}
              />
            ) : null}

            {project.repositoryUrl ? (
              <CheckoutPanel projectId={project.id} defaultBranch={project.defaultBranch} />
            ) : null}

            {project.memory ? (
              <Section
                title="What the agent found"
                description={`Analysed from the repository ${relativeTime(project.memory.updatedAt)}.`}
              >
                <div className="space-y-8">
                  <DetailList columns={3}>
                    <DetailItem label="Odoo version">
                      {project.memory.detectedOdooVersion ?? 'Not determined'}
                      {project.memory.detectedOdooVersion &&
                      project.odooVersion &&
                      project.memory.detectedOdooVersion !== project.odooVersion ? (
                        <span className="mt-0.5 block text-meta text-state-waiting">
                          The project is set to {project.odooVersion}
                        </span>
                      ) : null}
                    </DetailItem>
                    <DetailItem label="Python version">
                      {project.memory.pythonVersion ?? 'Not declared'}
                    </DetailItem>
                    <DetailItem label="Files">
                      {String(project.memory.repositoryStructure?.totalFiles ?? 0)}
                    </DetailItem>
                  </DetailList>

                  {project.memory.notes.length > 0 ? (
                    <Alert tone="warning" title="Observations">
                      <ul className="space-y-1">
                        {project.memory.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </Alert>
                  ) : null}

                  {project.memory.modules.length > 0 ? (
                    <Disclosure
                      summary="Modules in the repository"
                      hint={project.memory.modules.length}
                    >
                      <ul className="divide-y divide-surface-border/70 border-y border-surface-border/70">
                        {project.memory.modules.map((module) => (
                          <li
                            key={module.path}
                            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3"
                          >
                            <span className="min-w-0">
                              <span className="font-mono text-meta text-content">
                                {module.technicalName}
                              </span>
                              {module.name ? (
                                <span className="ml-2 text-callout text-content-muted">
                                  {module.name}
                                </span>
                              ) : null}
                              {module.isApplication ? (
                                <span className="ml-2 text-meta text-content-subtle">
                                  · Application
                                </span>
                              ) : null}
                              {module.installable === false ? (
                                <span className="ml-2 text-meta text-state-waiting">
                                  Not installable
                                </span>
                              ) : null}
                            </span>
                            <span className="shrink-0 font-mono text-caption text-content-subtle">
                              {module.version ?? 'no version'} · {module.fileCount} files
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  ) : null}

                  <p className="max-w-2xl text-meta text-content-subtle">
                    Read from the repository&rsquo;s own manifests and file names. Manifests are
                    parsed as text and never executed, and this record holds technical facts only,
                    never customer data.
                  </p>
                </div>
              </Section>
            ) : null}

            {project.specification ? (
              <Section
                title="Specification"
                description={`Version ${project.specificationVersion}`}
              >
                <div className="space-y-6">
                  <p className="max-w-2xl text-body text-content-muted">
                    {project.specification.description}
                  </p>
                  <p className="text-meta text-content-subtle">
                    Target environment:{' '}
                    <span className="text-content-muted">
                      {project.specification.deployment.environment}
                    </span>
                  </p>
                  <Disclosure
                    summary="Requirements"
                    hint={project.specification.requirements.length}
                  >
                    <ul className="space-y-3">
                      {project.specification.requirements.map((requirement) => (
                        <li key={requirement.id} className="flex gap-3">
                          <span className="mt-0.5 w-14 shrink-0 font-mono text-caption text-content-subtle">
                            {requirement.id}
                          </span>
                          <span className="min-w-0 text-callout text-content">
                            {requirement.title}
                            {requirement.detail ? (
                              <span className="block text-content-muted">{requirement.detail}</span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                </div>
              </Section>
            ) : null}
          </div>

          <aside className="min-w-0 space-y-10 lg:border-l lg:border-surface-border lg:pl-10">
            <Section size="small" title="Details">
              <DetailList>
                <DetailItem label="Odoo version">{project.odooVersion ?? 'Not set'}</DetailItem>
                <DetailItem label="Odoo edition">
                  {project.odooEdition === 'community' ? 'Community' : 'Enterprise'}
                </DetailItem>
                <DetailItem label="Default branch" mono>
                  {project.defaultBranch}
                </DetailItem>
                <DetailItem label="Repository" mono>
                  <span className="break-all">{project.repositoryUrl ?? 'None connected'}</span>
                </DetailItem>
                <DetailItem label="Your access">{humanise(project.accessReason)}</DetailItem>
                <DetailItem label="Created">{relativeTime(project.createdAt)}</DetailItem>
              </DetailList>
              {project.link.projectUrl ? (
                <Disclosure
                  summary="Linked instance"
                  hint={project.link.isOdoosh ? 'Odoo.sh' : 'On-premise'}
                  className="mt-6"
                >
                  <DetailList>
                    <DetailItem label="URL" mono>
                      <span className="break-all">{project.link.projectUrl}</span>
                    </DetailItem>
                    <DetailItem label="Database" mono>
                      {project.link.database ?? 'Not set'}
                    </DetailItem>
                    <DetailItem label="Kind">
                      {project.link.isOdoosh ? 'Odoo.sh' : 'On-premise'}
                    </DetailItem>
                  </DetailList>
                </Disclosure>
              ) : null}
            </Section>

            <Section size="small" title="Connections">
              {project.connections.length === 0 ? (
                <p className="text-callout text-content-muted">
                  No connection configured. The agent cannot reach a repository until one exists.
                </p>
              ) : (
                <ul className="space-y-4">
                  {project.connections.map((connection) => (
                    <li key={connection.id}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-callout font-medium text-content">
                          {humanise(connection.connectionType)}
                        </span>
                        <StatusDot
                          size="small"
                          tone={
                            connection.status === 'connected'
                              ? 'success'
                              : connection.status === 'error'
                                ? 'failure'
                                : 'idle'
                          }
                        >
                          {humanise(connection.status)}
                        </StatusDot>
                      </div>
                      <p className="mt-0.5 text-meta text-content-subtle">
                        {connection.hasCredentials
                          ? 'Credential held (encrypted, never returned)'
                          : 'No credential held'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              size="small"
              title="Agent permissions"
              actions={
                <Link href={`/projects/${project.id}/settings`} className="link text-callout">
                  Change
                </Link>
              }
            >
              <p className="text-callout text-content-muted">
                {grantedCount} of {grantedPermissions.length} granted
              </p>
              <Disclosure summary="Show permissions" className="mt-2">
                <ul className="space-y-2.5">
                  {grantedPermissions.map(([permission, granted]) => (
                    <li key={permission} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-callout text-content-muted">
                        {humanise(permission)}
                      </span>
                      <StatusDot size="small" tone={granted ? 'success' : 'idle'}>
                        {granted ? 'Granted' : 'Denied'}
                      </StatusDot>
                    </li>
                  ))}
                </ul>
              </Disclosure>
              <p className="mt-4 text-meta text-content-subtle">
                Database export and backup are never grantable. Production database records are
                denied by default and are not read, transmitted or stored.
              </p>
            </Section>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}

/** One quiet fact in the header's meta row. */
function MetaFact({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-meta text-content-subtle ${className}`}>
      {children}
    </span>
  );
}

/**
 * The page frame while the project loads: the same header and two columns,
 * with placeholders where the content will land, so nothing jumps on arrival.
 */
function ProjectDetailSkeleton() {
  return (
    <AppShell>
      <div className="page" role="status" aria-label="Loading project">
        <BackLink href="/projects" label="Projects" />
        <div className="mb-10 space-y-4 sm:mb-12">
          <Skeleton className="h-10 w-2/3 max-w-md" />
          <Skeleton className="h-4 w-1/2 max-w-sm" />
          <Skeleton className="h-3.5 w-3/4 max-w-lg" />
        </div>
        <div className="grid gap-12 lg:grid-cols-3 lg:gap-16">
          <div className="space-y-12 lg:col-span-2">
            <div className="space-y-4">
              <Skeleton className="h-6 w-32" />
              <SkeletonText lines={2} />
            </div>
            <div className="space-y-4">
              <Skeleton className="h-6 w-40" />
              <SkeletonRows rows={4} className="-mx-4" />
            </div>
          </div>
          <div className="space-y-4">
            <Skeleton className="h-5 w-24" />
            <SkeletonText lines={6} />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The instance as a person first wants it: is it up, and where is it. The
 * connection details that follow are the ones needed to reach it; everything
 * that acts on the instance sits lower, in `InstanceOperations`.
 */
function InstanceOverview({ provisioning }: { provisioning: ProjectProvisioningInfo }) {
  const state = INSTANCE_STATE[provisioning.status];

  return (
    <Section title="Instance">
      <div className="space-y-6">
        <div className="min-w-0">
          <StatusDot tone={state.tone} pulse={state.pulse}>
            {state.label}
          </StatusDot>
          {provisioning.url ? (
            <a
              href={provisioning.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex w-fit max-w-full items-center gap-1.5 break-all text-headline text-content transition-colors hover:text-accent"
            >
              {provisioning.url}
              <ArrowUpRight className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            </a>
          ) : (
            <p className="mt-2 text-body text-content-muted">Not provisioned</p>
          )}
        </div>

        {provisioning.status === 'failed' && provisioning.error ? (
          <Alert tone="error" title="Provisioning failed">
            {provisioning.error}
          </Alert>
        ) : null}

        {provisioning.status === 'pending' ? (
          <Alert tone="info" title="Provisioning in progress">
            The selected modules are being installed in the background. This page updates
            automatically once the instance is ready.
          </Alert>
        ) : null}

        <DetailList columns={3}>
          <DetailItem label="Database" mono>
            {provisioning.databaseName ?? 'None'}
          </DetailItem>
          <DetailItem label="HTTPS">
            {provisioning.https.status === 'issued'
              ? 'Active'
              : provisioning.https.status === 'failed'
                ? `Failed${provisioning.https.error ? ` — ${provisioning.https.error}` : ''}`
                : provisioning.https.status === 'pending'
                  ? 'Pending'
                  : 'Not issued (plain HTTP)'}
          </DetailItem>
          {provisioning.provisionedAt ? (
            <DetailItem label="Provisioned">{relativeTime(provisioning.provisionedAt)}</DetailItem>
          ) : null}
        </DetailList>
      </div>
    </Section>
  );
}

/**
 * One action on the instance: what it does on the left, the control on the
 * right (below on narrow screens), and its outcome underneath.
 */
function OperationRow({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 max-w-xl">
          <h3 className="text-body font-medium text-content">{title}</h3>
          {description ? (
            <p className="mt-1 text-callout text-content-muted">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-4 space-y-2 empty:hidden">{children}</div>
    </div>
  );
}

/** An outcome line under an operation: a success or a failure, in words. */
function Outcome({ tone, children }: { tone: 'success' | 'failure' | 'neutral'; children: ReactNode }) {
  const colour =
    tone === 'success'
      ? 'text-state-success'
      : tone === 'failure'
        ? 'text-state-failure'
        : 'text-content-subtle';
  return <p className={`text-meta ${colour}`}>{children}</p>;
}

/**
 * What can be done to the provisioned instance (ADR-039, ADR-040): deploy,
 * ship to production, back up, read its modules, and a "reveal" control for
 * the master password gated to admin/owner (enforced by the API; the button is
 * simply not shown to anyone else, since a 403 from clicking it would be a
 * confusing dead end).
 */
function InstanceOperations({
  projectId,
  provisioning,
  restart,
  repositoryUrl,
  isAdmin,
}: {
  projectId: string;
  provisioning: ProjectProvisioningInfo;
  restart: ProjectRestartInfo;
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

  const provisioned = provisioning.status === 'provisioned';

  // Every row below is gated on a provisioned instance or a held master
  // password; with neither, the section would be an empty box.
  if (!provisioned && !provisioning.hasMasterPassword) return null;

  return (
    <Section
      title="Instance operations"
      description="Deploy, ship and back up the instance, and reach its credentials."
    >
      <div className="panel divide-y divide-surface-border">
        {canReveal && provisioned ? (
          <OperationRow
            title="Deploy latest"
            description="Run this project's branch onto the instance. The server resets to the tip of the branch, so anything that is only on the server and not in the repository is replaced."
            action={
              <button
                type="button"
                onClick={() => void deploy()}
                disabled={deploying}
                className="btn-secondary"
              >
                {deploying ? <Spinner className="h-3.5 w-3.5" /> : null}
                {deploying ? 'Deploying…' : 'Deploy latest'}
              </button>
            }
          >
            {deployed ? (
              <Outcome tone="success">
                Deployed {deployed.branch ?? 'the branch'}
                {deployed.commit ? ` at ${deployed.commit.slice(0, 8)}` : ''}.
              </Outcome>
            ) : null}
            {deployError ? <Outcome tone="failure">{deployError}</Outcome> : null}
          </OperationRow>
        ) : null}

        {canReveal && repositoryUrl && provisioned ? (
          <OperationRow
            title="Ship to production"
            description="Merges this project's staging branch onto main (conflicts resolve in staging's favour), then upgrades and restarts the instance onto it. The instance is briefly stopped while the upgrade runs."
            action={
              <button
                type="button"
                onClick={() => void shipToProduction()}
                disabled={shipping || restarting}
                className="btn-secondary"
              >
                {shipping || restarting ? <Spinner className="h-3.5 w-3.5" /> : null}
                {shipStage === 'merging'
                  ? 'Merging staging into main…'
                  : shipStage === 'restarting' || restarting
                    ? 'Upgrading and restarting…'
                    : 'Ship staging to production'}
              </button>
            }
          >
            {merged ? (
              <Outcome tone="success">
                Merged into main at {merged.slice(0, 8)}.
                {shipStage === 'queued' ? ' Restart queued.' : ''}
              </Outcome>
            ) : null}
            {shipError ? <Outcome tone="failure">{shipError}</Outcome> : null}
            {restart.status !== 'none' ? (
              <Outcome tone={restart.status === 'failed' ? 'failure' : 'neutral'}>
                Last restart: {humanise(restart.status)}
                {restart.branch ? ` (${restart.branch})` : ''}
                {restart.commit ? ` @ ${restart.commit.slice(0, 8)}` : ''}
                {restart.error ? ` — ${restart.error}` : ''}
                {restart.restartedAt ? ` · ${relativeTime(restart.restartedAt)}` : ''}
              </Outcome>
            ) : null}
          </OperationRow>
        ) : null}

        <BackupsPanel projectId={projectId} provisioned={provisioned} />
        <ModulesPanel projectId={projectId} provisioned={provisioned} />

        {provisioning.hasMasterPassword ? (
          <OperationRow
            title="Master password"
            description={
              revealed
                ? 'Store this somewhere safe. It will not be shown here again without another reveal.'
                : canReveal
                  ? 'The instance’s database master password, held encrypted.'
                  : 'Held, encrypted. Only an organisation admin or owner can reveal it.'
            }
            action={
              !revealed && canReveal ? (
                <button
                  type="button"
                  onClick={() => void reveal()}
                  disabled={revealing}
                  className="btn-secondary"
                >
                  {revealing ? <Spinner className="h-3.5 w-3.5" /> : null}
                  {revealing ? 'Revealing…' : 'Reveal master password'}
                </button>
              ) : null
            }
          >
            {revealed ? (
              <code className="block break-all rounded-control bg-surface-overlay px-3 py-2.5 font-mono text-meta text-content">
                {revealed}
              </code>
            ) : null}
            {!revealed && canReveal && revealError ? (
              <Outcome tone="failure">{revealError}</Outcome>
            ) : null}
          </OperationRow>
        ) : null}
      </div>
    </Section>
  );
}

const BACKUP_TONE: Record<BackupSummary['status'], StatusTone> = {
  completed: 'success',
  failed: 'failure',
  running: 'running',
};

/**
 * The one long-lived local clone this host keeps of a connected project's
 * repository (ADR-063): a second source, so this project's code on this host
 * matches what is on GitHub or odoo.sh without waiting for a task to fetch it.
 *
 * One clone, every branch, like a working copy on a laptop. A Sync fetches all
 * of them at once and analyses the chosen one; a task takes its own worktree
 * from the same clone rather than downloading the repository again.
 *
 * Loads on mount so a person opening the page immediately sees whether the
 * local clone is behind, not only after pressing a button - that gap (a branch
 * updated upstream, not reflected here) is exactly the confusion this panel
 * exists to close.
 */
function CheckoutPanel({
  projectId,
  defaultBranch,
}: {
  projectId: string;
  defaultBranch: string;
}) {
  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.projects.checkoutStatus(projectId);
      setStatus(result);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not read the local clone.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) {
    return (
      <Section size="small" title="Local clone">
        <Outcome tone="failure">{loadError}</Outcome>
      </Section>
    );
  }

  if (!status) return null;

  if (!status.enabled) {
    return (
      <Section size="small" title="Local clone">
        <p className="text-callout text-content-muted">
          {status.reason ?? 'Local clones are not enabled on this deployment.'}
        </p>
      </Section>
    );
  }

  const sync = async (branch: string) => {
    setSyncing(branch);
    setSyncError(null);
    setSyncNotice(null);
    try {
      const result = await api.projects.syncCheckout(projectId, branch);
      setSyncNotice(result.message);
      await load();
    } catch (caught) {
      setSyncError(caught instanceof ApiError ? caught.message : 'The sync could not run.');
    } finally {
      setSyncing(null);
    }
  };

  return (
    <Section
      size="small"
      title="Local clone"
      description={
        status.path
          ? `${status.cloned ? 'One clone, kept' : 'Will be cloned'} at ${status.path} — every branch is fetched together, and tasks work from it instead of cloning again.`
          : undefined
      }
    >
      {status.reason ? (
        <p className="text-callout text-content-muted">{status.reason}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="text-meta text-content-subtle">
              {status.cloned
                ? `${status.branches.filter((branch) => branch.exists).length} of ${status.branches.length} branch(es) here.`
                : 'Not cloned yet. Cloning brings every branch onto this host at once.'}
            </p>
            <button
              type="button"
              onClick={() => void sync(defaultBranch)}
              disabled={syncing !== null}
              className="btn-secondary shrink-0"
            >
              {syncing === defaultBranch ? <Spinner className="h-3.5 w-3.5" /> : null}
              {syncing === defaultBranch
                ? status.cloned
                  ? 'Syncing…'
                  : 'Cloning…'
                : status.cloned
                  ? 'Sync'
                  : `Clone ${defaultBranch}`}
            </button>
          </div>

          <ul className="mt-3 divide-y divide-surface-border/70 border-y border-surface-border/70">
            {status.branches.map((branch) => (
              <li
                key={branch.branch}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3.5"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-mono text-callout text-content">
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-content-subtle" strokeWidth={1.75} aria-hidden="true" />
                    {branch.branch}
                  </p>
                  <p className="mt-1 text-meta text-content-subtle">
                    {!branch.exists
                      ? 'Not on this host — the remote has no such branch, or it has not been fetched.'
                      : branch.inUse
                        ? `A task is working on this branch${branch.dirty ? ' with uncommitted changes' : ''}.`
                        : branch.ahead
                          ? `${branch.ahead} local commit(s) not on the remote yet.`
                          : branch.behind === null
                            ? `At ${branch.commit?.slice(0, 8) ?? 'unknown'}. Sync to compare with the remote.`
                            : branch.behind === 0
                              ? `Up to date at ${branch.commit?.slice(0, 8) ?? ''}.`
                              : `${branch.behind} commit${branch.behind === 1 ? '' : 's'} behind the remote.`}
                    {branch.lastSyncedAt ? ` · Synced ${relativeTime(branch.lastSyncedAt)}` : ''}
                  </p>
                </div>
                <p className="shrink-0 font-mono text-meta text-content-subtle">
                  {branch.historyDepth !== null ? `${branch.historyDepth} commits` : ''}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

      {syncNotice ? <Outcome tone="success">{syncNotice}</Outcome> : null}
      {syncError ? <Outcome tone="failure">{syncError}</Outcome> : null}
    </Section>
  );
}

/**
 * The per-client backups (ADR-054): a restorable snapshot of the database, the
 * filestore and the addons repository, taken before a push onto a staging (or
 * main-named) branch and on request here. The snapshot itself lives under
 * /opt/odoo/backups on the host and is restorable by an operator without this
 * platform; this row shows what exists and asks for one more.
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
    <OperationRow
      title="Backups"
      description="A restore point of this instance's database, filestore and addons repository, kept on the host under /opt/odoo/backups. One is taken automatically before a push onto a staging or main branch."
      action={
        available ? (
          <button
            type="button"
            onClick={() => void runBackup()}
            disabled={busy}
            className="btn-secondary"
          >
            {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
            {busy ? 'Backing up…' : 'Back up now'}
          </button>
        ) : null
      }
    >
      {latest ? (
        <ul className="divide-y divide-surface-border/70">
          {backups.slice(0, 3).map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5"
            >
              <span className="min-w-0 truncate font-mono text-caption text-content-muted">
                {row.backupId ?? row.createdAt}
              </span>
              <span className="flex items-center gap-2 text-meta text-content-subtle">
                <StatusDot size="small" tone={BACKUP_TONE[row.status] ?? 'neutral'}>
                  {humanise(row.status)}
                </StatusDot>
                {row.reason === 'pre_push' ? <span>· Before a push</span> : null}
                {row.sizeBytes ? (
                  <span>· {Math.round(row.sizeBytes / 1024 / 1024)} MB</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Outcome tone="neutral">No backups yet.</Outcome>
      )}

      {!available ? (
        <Outcome tone="neutral">
          {availabilityReason ?? 'Backup is not enabled on this deployment.'}
        </Outcome>
      ) : null}

      {notice ? <Outcome tone="success">{notice}</Outcome> : null}
      {error ? <Outcome tone="failure">{error}</Outcome> : null}
    </OperationRow>
  );
}

/**
 * What is actually installed in the instance (ADR-056) — as opposed to what
 * the module picker asked for at creation, which is only ever a request. Reads
 * fresh on request, once (no polling: unlike provisioning status this does not
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
    <OperationRow
      title="Installed modules"
      description={
        !loaded
          ? 'Read fresh from the instance’s own database on request, not cached.'
          : undefined
      }
      action={
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="btn-secondary"
        >
          {loading ? <Spinner className="h-3.5 w-3.5" /> : null}
          {loading ? 'Reading…' : loaded ? 'Refresh' : 'Show modules'}
        </button>
      }
    >
      {!loaded ? null : !available ? (
        <Outcome tone="neutral">
          {reason ?? 'Reading installed modules is not enabled on this deployment.'}
        </Outcome>
      ) : reason ? (
        <Outcome tone="failure">{reason}</Outcome>
      ) : installed.length === 0 ? (
        <Outcome tone="neutral">No modules reported.</Outcome>
      ) : (
        <>
          <p className="text-callout text-content-muted">
            {installed.length} module{installed.length === 1 ? '' : 's'} installed
          </p>
          <ul className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
            {installed.map((module) => (
              <li key={module.name} className="code-chip">
                {module.name}
              </li>
            ))}
          </ul>
        </>
      )}

      {error ? <Outcome tone="failure">{error}</Outcome> : null}
    </OperationRow>
  );
}
