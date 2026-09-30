'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { GitBranch, Lock, RefreshCw } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import { BackLink, PageHeader } from '@/components/ui/page';
import { StatusDot } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailItem, DetailList } from '@/components/ui/detail-list';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { humanise, relativeTime } from '@/lib/format';
import { EnvironmentKindBadge } from '@/components/projects/environment-editor';
import { ProjectAccessPanel } from '@/components/projects/project-access-panel';
import type {
  AgentCapabilities,
  EnvironmentKind,
  GitTransport,
  ProjectDetail,
  ProjectEnvironment,
  ProjectGitAccess,
} from '@/lib/types';
import { GIT_TRANSPORT_LABELS, GIT_TRANSPORTS } from '@/lib/types';

const NEVER_GRANTABLE = ['database_export', 'database_backup'];

const PERMISSION_NOTES: Record<string, string> = {
  repository_read: 'Read source code, module structure, views and manifests.',
  repository_write: 'Modify files on the isolated task branch.',
  git_commit: 'Create commits on the task branch.',
  git_push: 'Push the branch to the connected repository. Always requires approval.',
  run_tests: 'Run linting and tests against an isolated temporary database.',
  database_metadata_read: 'Read model and field names. Carries no customer data.',
  database_record_read: 'Read customer records. Denied by default.',
  database_record_write: 'Write customer records. Denied by default; requires approval.',
  restart_odoo: 'Restart the Odoo service. Requires approval.',
  production_deploy: 'Deploy to production. Out of scope for the MVP.',
};

/**
 * Project settings: agent permissions, the data boundary, environments, git
 * access, connections, who may open the project, and its removal.
 *
 * Laid out as a column of settings groups, each with its explanation beside
 * its controls; the destructive group comes last and is set apart.
 *
 * The two capabilities that can never be granted are shown as permanently
 * disabled rows rather than omitted, so an operator can see that the platform
 * refuses them by design and does not simply lack the feature.
 */
export default function ProjectSettingsPage() {
  const { loading, user } = useRequireAuth();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [localOnly, setLocalOnly] = useState(false);
  const [boundarySaving, setBoundarySaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [gitAccess, setGitAccess] = useState<ProjectGitAccess | null>(null);
  const [gitAccessDraft, setGitAccessDraft] = useState<{
    gitTransport: GitTransport;
    gitCredentialId: string;
    gitUsername: string;
  }>({ gitTransport: 'auto', gitCredentialId: '', gitUsername: '' });
  const [gitAccessSaving, setGitAccessSaving] = useState(false);

  const canEdit = user?.isAdmin ?? false;

  const load = useCallback(async () => {
    try {
      const [detail, environmentList] = await Promise.all([
        api.projects.get(projectId),
        api.projects.environments(projectId),
      ]);
      setProject(detail);
      setPermissions(detail.agentPermissions);
      setLocalOnly(detail.localProviderOnly);
      setEnvironments(environmentList);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The project could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    void api.agent
      .capabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Moves the default target. The server refuses to point it at production, so
   * this only ever offers the environments that can hold it.
   */
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);

  const isOwner = user?.isAdmin ?? false;

  /** Archive, restore and delete share their reporting, so they share a wrapper. */
  const run = async (
    action: () => Promise<void>,
    failure: string,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const archive = () =>
    run(async () => {
      const result = await api.projects.archive(projectId);
      setNotice(result.message);
      await load();
    }, 'The project could not be archived.');

  const restore = () =>
    run(async () => {
      await api.projects.restore(projectId);
      setNotice('The project was restored.');
      await load();
    }, 'The project could not be restored.');

  /**
   * On success there is no project left to render, so this navigates away rather
   * than reloading into a 404.
   */
  const destroy = () =>
    run(async () => {
      const result = await api.projects.destroy(projectId, confirmName);
      router.replace(
        `/projects?deleted=${encodeURIComponent(result.projectName)}` +
          `&tasks=${result.tasksDeleted}`,
      );
    }, 'The project could not be deleted.');

  const [newEnvironment, setNewEnvironment] = useState<{
    name: string;
    branch: string;
    kind: EnvironmentKind;
  }>({ name: '', branch: '', kind: 'development' });

  /**
   * A project's git transport and credential (ADR-059).
   *
   * Loaded alongside the page rather than lazily: unlike the branch list, this
   * panel is the page's whole reason for existing once an operator has a
   * repository connected, and an empty form would misrepresent a project that
   * already has a credential.
   */
  const loadGitAccess = useCallback(async () => {
    try {
      const access = await api.projects.gitAccess(projectId);
      setGitAccess(access);
      setGitAccessDraft({
        gitTransport: access.gitTransport,
        gitCredentialId: access.gitCredentialId ?? '',
        gitUsername: access.gitUsername ?? '',
      });
    } catch {
      // The panel stays hidden: it is not the page's primary purpose, and a
      // project that cannot report its git access has nothing useful to show.
      setGitAccess(null);
    }
  }, [projectId]);

  useEffect(() => {
    void loadGitAccess();
  }, [loadGitAccess]);

  /**
   * Saves the transport and credential.
   *
   * An empty selection is sent as `null` rather than omitted, so clearing the
   * choice actually clears it: the server then falls back to the deployment
   * default instead of keeping the old value.
   */
  const saveGitAccess = async () => {
    setGitAccessSaving(true);
    setError(null);
    setNotice(null);

    try {
      const updated = await api.projects.updateGitAccess(projectId, {
        gitTransport: gitAccessDraft.gitTransport,
        gitCredentialId: gitAccessDraft.gitCredentialId || null,
        gitUsername: gitAccessDraft.gitUsername.trim() || null,
      });
      setGitAccess(updated);
      setNotice('Git access updated.');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The git access could not be updated.',
      );
    } finally {
      setGitAccessSaving(false);
    }
  };

  const [branches, setBranches] = useState<string[] | undefined>(undefined);
  const [readingBranches, setReadingBranches] = useState(false);

  /**
   * Asks the repository which branches it has, so the branch below is picked
   * rather than typed. Not read on load: it is a network call to the remote,
   * and most visits to this page are not about environments.
   */
  const readBranches = async () => {
    setReadingBranches(true);
    setError(null);

    try {
      const { branches: found } = await api.projects.remoteBranches(projectId);
      setBranches(found);
    } catch (caught) {
      // The field stays typeable, so this is a note rather than a dead end.
      setError(
        caught instanceof ApiError ? caught.message : 'The branches could not be read.',
      );
    } finally {
      setReadingBranches(false);
    }
  };

  /**
   * Adds an environment to an existing project.
   *
   * Needed because a project created before environments existed has none, and
   * without this there is no way to give it one: it lists nothing, no task can
   * run, and the portal offers no way out (ADR-021 declares environments at
   * creation only). Not back-filled automatically on purpose — guessing that a
   * project's default branch is a development branch is exactly the mistake the
   * production refusal exists to prevent.
   */
  const addEnvironment = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      await api.projects.addEnvironment(projectId, {
        name: newEnvironment.name.trim(),
        branch: newEnvironment.branch.trim(),
        kind: newEnvironment.kind,
      });
      setEnvironments(await api.projects.environments(projectId));
      setNewEnvironment({ name: '', branch: '', kind: 'development' });
      setNotice(`Added the "${newEnvironment.name.trim()}" environment.`);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The environment could not be added.',
      );
    } finally {
      setSaving(false);
    }
  };
  const makeDefault = async (environmentId: string) => {
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      setEnvironments(await api.projects.setDefaultEnvironment(projectId, environmentId));
      setNotice('The default target environment was changed.');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The default target could not be changed.',
      );
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.projects.updateAgentPermissions(projectId, permissions);
      setPermissions(updated);
      setNotice('Agent permissions updated.');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The permissions could not be updated.',
      );
    } finally {
      setSaving(false);
    }
  };

  /**
   * The data-boundary switch (ADR-055). Saved immediately rather than on a Save
   * button: it is one boolean, and a half-saved permissions form must not carry
   * it along.
   */
  const saveLocalOnly = async (next: boolean) => {
    setBoundarySaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.projects.update(projectId, { localProviderOnly: next });
      setLocalOnly(Boolean((updated as { localProviderOnly?: boolean }).localProviderOnly));
      setNotice(
        next
          ? 'This project now uses on-host models only. Nothing about it leaves the server.'
          : 'The restriction was lifted: tasks may use any configured provider again.',
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The restriction could not be updated.',
      );
    } finally {
      setBoundarySaving(false);
    }
  };

  if (loading || !user) return <PageLoading />;
  if (!project) {
    return (
      <AppShell>
        <div className="page">
          <BackLink href={`/projects/${projectId}`} label="Project" />
          {error ? (
            <div className="max-w-2xl">
              <Alert tone="error" title="Settings unavailable">
                {error}
              </Alert>
            </div>
          ) : (
            <SettingsSkeleton />
          )}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="page">
        <PageHeader
          back={{ href: `/projects/${project.id}`, label: project.name }}
          title="Settings"
          description="What the agent may do on this project, where it works, and who can open it."
        />

        {notice || error ? (
          <div className="-mt-4 mb-10 space-y-3 sm:-mt-6">
            {notice ? <Alert tone="success">{notice}</Alert> : null}
            {error ? <Alert tone="error">{error}</Alert> : null}
          </div>
        ) : null}

        <div className="divide-y divide-surface-border">
          <SettingsGroup
            title="Agent permissions"
            description="What the agent may do on this project. Independent of user roles: holding the owner role does not let the agent read production data."
            aside={canEdit ? undefined : 'Admin role required to change.'}
          >
            <div className="panel overflow-hidden">
              <ul className="divide-y divide-surface-border/70">
                {Object.entries(permissions).map(([permission, granted]) => (
                  <li key={permission}>
                    <label
                      className={`flex items-start justify-between gap-4 px-5 py-4 sm:px-6 ${
                        canEdit ? 'cursor-pointer' : ''
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block text-callout font-medium text-content">
                          {humanise(permission)}
                        </span>
                        <span className="mt-0.5 block text-meta text-content-subtle">
                          {PERMISSION_NOTES[permission] ?? ''}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2.5 pt-0.5">
                        <span
                          className={`hidden text-meta sm:inline ${
                            granted ? 'text-content' : 'text-content-subtle'
                          }`}
                        >
                          {granted ? 'Granted' : 'Denied'}
                        </span>
                        <input
                          type="checkbox"
                          checked={granted}
                          disabled={!canEdit}
                          aria-label={`${humanise(permission)}: ${granted ? 'granted' : 'denied'}`}
                          onChange={(event) =>
                            setPermissions((previous) => ({
                              ...previous,
                              [permission]: event.target.checked,
                            }))
                          }
                          className="h-4 w-4 accent-accent"
                        />
                      </span>
                    </label>
                  </li>
                ))}

                {NEVER_GRANTABLE.map((capability) => (
                  <li
                    key={capability}
                    className="flex items-start justify-between gap-4 px-5 py-4 sm:px-6"
                  >
                    <span className="min-w-0">
                      <span className="block text-callout font-medium text-content-muted">
                        {humanise(capability)}
                      </span>
                      <span className="mt-0.5 block text-meta text-content-subtle">
                        Never grantable. The agent is refused this capability by design.
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-meta text-content-subtle">
                      <Lock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Always denied
                    </span>
                  </li>
                ))}
              </ul>

              {canEdit ? (
                <div className="flex justify-end border-t border-surface-border px-5 py-4 sm:px-6">
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving}
                    className="btn-primary"
                  >
                    {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
                    Save permissions
                  </button>
                </div>
              ) : null}
            </div>
          </SettingsGroup>

          <SettingsGroup
            title="Data boundary"
            description="Keep this project's tasks on models that run on this server."
            aside={canEdit ? 'Saved immediately.' : 'Admin role required to change.'}
          >
            <div className="panel">
              <label
                className={`flex items-start gap-3.5 px-5 py-5 sm:px-6 ${
                  canEdit && !boundarySaving ? 'cursor-pointer' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={localOnly}
                  disabled={!canEdit || boundarySaving}
                  onChange={(event) => void saveLocalOnly(event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 accent-accent"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-callout font-medium text-content">
                    On-host models only, no off-host egress
                    {boundarySaving ? <Spinner className="h-3.5 w-3.5 text-content-subtle" /> : null}
                  </span>
                  <span className="mt-1 block text-meta text-content-subtle">
                    Every task on this project uses only providers whose base URL is loopback, so no
                    source code, document or screenshot reaches an external model. A task is refused
                    when this deployment has no such provider. Turning it off allows off-host egress
                    again.
                  </span>
                </span>
              </label>
            </div>
          </SettingsGroup>

          <SettingsGroup
            title="Environments"
            description="On Odoo.sh an environment is a branch. A task may target a staging or development environment; one marked production is refused, because that branch is the live business."
          >
            <div className="panel overflow-hidden">
              {environments.length === 0 ? (
                <EmptyState
                  compact
                  icon={GitBranch}
                  title="No environments"
                  description="No environments declared, so no task can run. Add one through the API or by recreating the project."
                />
              ) : (
                <ul className="divide-y divide-surface-border/70">
                  {environments.map((environment) => (
                    <li
                      key={environment.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4 sm:px-6"
                    >
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-callout font-medium text-content">
                            {environment.name}
                          </span>
                          <EnvironmentKindBadge kind={environment.kind} />
                          {environment.isDefaultTarget ? (
                            <span className="text-meta text-content-muted">Default target</span>
                          ) : null}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-content-subtle">
                          <span className="font-mono text-caption">{environment.branch}</span>
                          {environment.kind === 'production' ? (
                            <span className="text-state-failure">Not targetable</span>
                          ) : null}
                        </p>
                      </div>
                      {environment.kind !== 'production' &&
                      !environment.isDefaultTarget &&
                      canEdit ? (
                        <button
                          type="button"
                          onClick={() => void makeDefault(environment.id)}
                          disabled={saving}
                          className="btn-ghost btn-sm -mr-2"
                        >
                          Make default
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {canEdit ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addEnvironment();
                  }}
                  className="border-t border-surface-border bg-surface/40 px-5 py-5 sm:px-6"
                >
                  <p className="text-callout font-medium text-content">Add an environment</p>
                  <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem]">
                    <label className="block min-w-0">
                      <span className="mb-1.5 block text-meta font-medium text-content-muted">
                        Name
                      </span>
                      <input
                        aria-label="Environment name"
                        value={newEnvironment.name}
                        onChange={(event) =>
                          setNewEnvironment((previous) => ({ ...previous, name: event.target.value }))
                        }
                        placeholder="staging"
                        disabled={saving}
                        className="field-input"
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="mb-1.5 block text-meta font-medium text-content-muted">
                        Branch
                      </span>
                      {branches ? (
                        <select
                          aria-label="Environment branch"
                          value={newEnvironment.branch}
                          onChange={(event) =>
                            setNewEnvironment((previous) => ({
                              ...previous,
                              branch: event.target.value,
                            }))
                          }
                          disabled={saving}
                          className="field-input font-mono text-callout"
                        >
                          <option value="">Pick a branch</option>
                          {branches.map((branch) => (
                            <option key={branch} value={branch}>
                              {branch}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-label="Environment branch"
                          value={newEnvironment.branch}
                          onChange={(event) =>
                            setNewEnvironment((previous) => ({
                              ...previous,
                              branch: event.target.value,
                            }))
                          }
                          placeholder="StagingDM"
                          disabled={saving}
                          className="field-input font-mono text-callout"
                        />
                      )}
                    </label>
                    <label className="block min-w-0">
                      <span className="mb-1.5 block text-meta font-medium text-content-muted">
                        Type
                      </span>
                      <select
                        aria-label="Environment kind"
                        value={newEnvironment.kind}
                        onChange={(event) =>
                          setNewEnvironment((previous) => ({
                            ...previous,
                            kind: event.target.value as EnvironmentKind,
                          }))
                        }
                        disabled={saving}
                        className="field-input"
                      >
                        <option value="development">Development</option>
                        <option value="staging">Staging</option>
                        <option value="production">Production</option>
                      </select>
                    </label>
                  </div>
                  <p className="field-hint">
                    {branches
                      ? `Picking from the ${branches.length} branch${branches.length === 1 ? '' : 'es'} the repository has.`
                      : 'Branch names are case-sensitive: read the branches to pick one that exists.'}
                  </p>
                  {environments.length === 0 ? (
                    <p className="mt-2 text-meta text-state-waiting">
                      This project has no environments, so no task can run against it. Add the
                      branch you want the agent to work on.
                    </p>
                  ) : null}
                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      disabled={
                        saving ||
                        newEnvironment.name.trim() === '' ||
                        newEnvironment.branch.trim() === ''
                      }
                      className="btn-secondary"
                    >
                      Add environment
                    </button>
                    <button
                      type="button"
                      onClick={() => void readBranches()}
                      disabled={saving || readingBranches}
                      className="btn-ghost"
                    >
                      {readingBranches ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <RefreshCw className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                      )}
                      {readingBranches ? 'Reading' : 'Read branches'}
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          </SettingsGroup>

          {capabilities ? (
            <SettingsGroup
              title="Pushing"
              description="Whether this server lets the agent push branches to a repository."
            >
              <div className="panel px-5 py-5 sm:px-6">
                <StatusDot tone={capabilities.git.pushEnabled ? 'success' : 'idle'}>
                  {capabilities.git.pushEnabled
                    ? 'Enabled on this server'
                    : 'Disabled on this server'}
                </StatusDot>
                <p className="mt-2 text-meta text-content-subtle">{capabilities.git.pushReason}</p>
              </div>
            </SettingsGroup>
          ) : null}

          {gitAccess ? (
            <SettingsGroup
              title="Git access"
              description="How the agent reaches this repository. A token works over HTTPS; an SSH key works over SSH. The two are not interchangeable, so a project whose remote is HTTPS and whose only credential is an SSH key cannot push."
              aside={canEdit ? undefined : 'Admin role required to change.'}
            >
              <div className="panel overflow-hidden">
                <div className="space-y-6 px-5 py-6 sm:px-6">
                  <DetailList>
                    <DetailItem label="Repository" mono>
                      <span className="break-all">
                        {gitAccess.repositoryUrl ?? 'No repository connected.'}
                      </span>
                    </DetailItem>
                  </DetailList>

                  <div>
                    <label htmlFor="gitTransport" className="field-label">
                      Transport
                    </label>
                    <select
                      id="gitTransport"
                      value={gitAccessDraft.gitTransport}
                      disabled={!canEdit}
                      onChange={(event) =>
                        setGitAccessDraft((previous) => ({
                          ...previous,
                          gitTransport: event.target.value as GitTransport,
                        }))
                      }
                      className="field-input"
                    >
                      {GIT_TRANSPORTS.map((transport) => (
                        <option key={transport} value={transport}>
                          {GIT_TRANSPORT_LABELS[transport]}
                        </option>
                      ))}
                    </select>
                    <p className="field-hint">
                      {gitAccess.effectiveTransport
                        ? `In effect: ${gitAccess.effectiveTransport.toUpperCase()}.` +
                          (gitAccess.urlTransport &&
                          gitAccess.effectiveTransport !== gitAccess.urlTransport
                            ? ' The repository URL is rewritten to match; the stored URL is left alone.'
                            : '')
                        : 'Set a repository URL first.'}
                    </p>
                  </div>

                  <div>
                    <label htmlFor="gitCredential" className="field-label">
                      Credential
                    </label>
                    <select
                      id="gitCredential"
                      value={gitAccessDraft.gitCredentialId}
                      disabled={!canEdit}
                      onChange={(event) =>
                        setGitAccessDraft((previous) => ({
                          ...previous,
                          gitCredentialId: event.target.value,
                        }))
                      }
                      className="field-input"
                    >
                      <option value="">Use the deployment default</option>
                      {gitAccess.availableCredentials.map((credential) => (
                        <option key={credential.id} value={credential.id}>
                          {credential.label} ({credential.credentialKind === 'ssh_key' ? 'SSH key' : 'token'}
                          {credential.isDefault ? ', default' : ''})
                        </option>
                      ))}
                    </select>
                    <p className="field-hint">
                      {gitAccess.effectiveCredentialLabel
                        ? `In effect: ${gitAccess.effectiveCredentialLabel} (${gitAccess.effectiveCredentialSource.replace('_', ' ')}).`
                        : 'No credential is in effect for this project, so a push to a private repository will fail.'}
                    </p>
                  </div>

                  <div>
                    {/*
                      Only meaningful over HTTPS: an SSH remote carries its own user
                      in the URL, and git ignores this value there.
                    */}
                    <label htmlFor="gitUsername" className="field-label">
                      Username <span className="font-normal text-content-subtle">(HTTPS only)</span>
                    </label>
                    <input
                      id="gitUsername"
                      type="text"
                      value={gitAccessDraft.gitUsername}
                      disabled={!canEdit}
                      onChange={(event) =>
                        setGitAccessDraft((previous) => ({
                          ...previous,
                          gitUsername: event.target.value,
                        }))
                      }
                      placeholder="e.g. x-access-token"
                      className="field-input"
                    />
                    <p className="field-hint">
                      Left empty, tokens are presented as{' '}
                      <code className="code-chip">x-access-token</code>, which GitHub and GitLab
                      both accept.
                    </p>
                  </div>

                  {gitAccess.urlTransport && gitAccess.effectiveTransport &&
                  gitAccess.urlTransport !== gitAccess.effectiveTransport ? (
                    <Alert tone="warning">
                      The repository URL is stored as {gitAccess.urlTransport.toUpperCase()} but this
                      project is set to use {gitAccess.effectiveTransport.toUpperCase()}. The URL is
                      converted when the agent runs; change the stored URL on the repository form if
                      you want the two to agree.
                    </Alert>
                  ) : null}

                  {gitAccess.effectiveCredentialSource === 'deployment_default' ? (
                    <p className="text-meta text-content-subtle">
                      Falling back to the deployment default from Settings → Git credentials. Pick one
                      here to give this project its own.
                    </p>
                  ) : null}

                  {gitAccess.effectiveCredentialSource === 'none' ? (
                    <Alert tone="error" title="No credential applies">
                      Pushing to a private repository will fail with a credential prompt the server
                      cannot answer.
                    </Alert>
                  ) : null}
                </div>

                {canEdit ? (
                  <div className="flex justify-end border-t border-surface-border px-5 py-4 sm:px-6">
                    <button
                      type="button"
                      onClick={() => void saveGitAccess()}
                      disabled={gitAccessSaving}
                      className="btn-primary"
                    >
                      {gitAccessSaving ? <Spinner className="h-3.5 w-3.5" /> : null}
                      Save git access
                    </button>
                  </div>
                ) : null}
              </div>
            </SettingsGroup>
          ) : null}

          <SettingsGroup
            title="Connections"
            description="The repository connections this project holds."
          >
            <div className="panel overflow-hidden">
              {project.connections.length === 0 ? (
                <p className="px-5 py-5 text-callout text-content-muted sm:px-6">
                  No connection configured. Add one when creating a project, or through the API.
                </p>
              ) : (
                <ul className="divide-y divide-surface-border/70">
                  {project.connections.map((connection) => (
                    <li
                      key={connection.id}
                      className="flex items-center justify-between gap-4 px-5 py-4 sm:px-6"
                    >
                      <div className="min-w-0">
                        <p className="text-callout font-medium text-content">
                          {humanise(connection.connectionType)}
                        </p>
                        <p className="mt-0.5 text-meta text-content-subtle">
                          {connection.hasCredentials
                            ? 'Credential held, encrypted under a key unique to this project'
                            : 'No credential held'}
                        </p>
                      </div>
                      <StatusDot
                        size="small"
                        tone={
                          connection.status === 'connected'
                            ? 'success'
                            : connection.status === 'error'
                              ? 'failure'
                              : 'idle'
                        }
                        className="shrink-0"
                      >
                        {humanise(connection.status)}
                      </StatusDot>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SettingsGroup>

          {/* Only an owner or admin may change who reaches this project (ADR-043). */}
          {canEdit ? (
            <SettingsGroup
              title="Project access"
              description="Owners and admins reach every project. Everyone else needs to be given access here."
            >
              <ProjectAccessPanel projectId={projectId} />
            </SettingsGroup>
          ) : null}

          <SettingsGroup
            title="Archive or delete"
            description="Archiving can be undone at any time. Deleting cannot."
            danger
          >
            <div className="panel divide-y divide-surface-border border-state-failure/30">
              <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8 sm:px-6">
                <div className="min-w-0 max-w-xl">
                  <p className="text-body font-medium text-content">
                    {project.archivedAt ? 'Archived' : 'Archive'}
                  </p>
                  <p className="mt-1 text-callout text-content-muted">
                    {project.archivedAt
                      ? `Archived ${relativeTime(project.archivedAt)}. It is hidden from the ` +
                        'project list and cannot accept new tasks. Nothing has been deleted.'
                      : 'Hides it from the project list and stops it accepting new tasks. ' +
                        'Nothing is deleted, and it can be restored at any time.'}
                  </p>
                </div>

                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => void (project.archivedAt ? restore() : archive())}
                    disabled={busy}
                    className="btn-secondary shrink-0 self-start"
                  >
                    {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
                    {project.archivedAt ? 'Restore project' : 'Archive project'}
                  </button>
                ) : null}
              </div>

              <div className="px-5 py-5 sm:px-6">
                <p className="text-body font-medium text-state-failure">Delete permanently</p>
                <p className="mt-1 max-w-xl text-callout text-content-muted">
                  Removes the project and everything it owns: every task and its diffs, the
                  approval history, the environments, the connections and any stored credential.
                  This cannot be undone.
                </p>
                <p className="mt-2 max-w-xl text-meta text-content-subtle">
                  The repository itself is untouched — this platform never pushes to it, and
                  deleting a project here changes nothing on GitHub or Odoo.sh.
                </p>

                {isOwner ? (
                  <div className="mt-5 max-w-md">
                    <label htmlFor="confirmName" className="field-label">
                      Type <span className="font-mono text-meta">{project.name}</span> to confirm
                    </label>
                    <input
                      id="confirmName"
                      value={confirmName}
                      onChange={(event) => setConfirmName(event.target.value)}
                      disabled={busy}
                      autoComplete="off"
                      placeholder={project.name}
                      className="field-input font-mono text-callout"
                    />
                    <button
                      type="button"
                      onClick={() => void destroy()}
                      disabled={busy || confirmName.trim() !== project.name}
                      className="btn-danger mt-3"
                    >
                      {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
                      Delete this project permanently
                    </button>
                  </div>
                ) : (
                  <p className="mt-4 text-meta text-content-subtle">
                    Only an organisation owner can delete a project permanently.
                  </p>
                )}
              </div>
            </div>
          </SettingsGroup>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * One group of settings. On wide screens the title and a line of explanation
 * sit on the left and the controls on the right, so a long page reads as a
 * column of short decisions; on narrow screens the two stack.
 *
 * `danger` marks the destructive group, which is always last.
 */
function SettingsGroup({
  title,
  description,
  aside,
  danger = false,
  children,
}: {
  title: string;
  description: string;
  /** A quiet note under the explanation, such as who may change it. */
  aside?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`grid gap-5 py-10 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-12 ${
        danger ? 'mt-8' : ''
      }`}
    >
      <div className="min-w-0">
        <h2 className={`text-headline ${danger ? 'text-state-failure' : 'text-content'}`}>
          {title}
        </h2>
        <p className="mt-1.5 text-callout text-content-muted">{description}</p>
        {aside ? <p className="mt-2 text-meta text-content-subtle">{aside}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** Placeholders for the settings layout while the project loads. */
function SettingsSkeleton() {
  return (
    <div role="status" aria-label="Loading settings">
      <div className="mb-10 space-y-3 sm:mb-12">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-2/3 max-w-md" />
      </div>
      <div className="space-y-12">
        {[0, 1, 2].map((index) => (
          <div key={index} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-12">
            <div className="space-y-2">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            <div className="panel">
              <SkeletonRows rows={3} className="px-1 py-1 sm:px-2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
