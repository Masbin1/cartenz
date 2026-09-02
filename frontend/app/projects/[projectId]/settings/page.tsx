'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import { humanise, relativeTime } from '@/lib/format';
import { EnvironmentKindBadge } from '@/components/projects/environment-editor';
import type {
  AgentCapabilities,
  EnvironmentKind,
  ProjectDetail,
  ProjectEnvironment,
} from '@/lib/types';

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
 * Project settings: agent permissions and repository connections.
 *
 * The two capabilities that can never be granted are shown as permanently
 * disabled rows rather than omitted, so an operator can see that the platform
 * refuses them by design and does not simply lack the feature.
 */
export default function ProjectSettingsPage() {
  const { loading, user, organization } = useRequireAuth();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);

  const canEdit = organization?.role === 'owner' || organization?.role === 'admin';

  const load = useCallback(async () => {
    try {
      const [detail, environmentList] = await Promise.all([
        api.projects.get(projectId),
        api.projects.environments(projectId),
      ]);
      setProject(detail);
      setPermissions(detail.agentPermissions);
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

  const isOwner = organization?.role === 'owner';

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

  if (loading || !user) return <PageLoading />;
  if (!project) return <PageLoading label="Loading settings" />;

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-5 py-7">
        <nav className="mb-4 flex items-center gap-1.5 text-2xs text-content-subtle">
          <Link href="/projects" className="hover:text-content">
            Projects
          </Link>
          <span>/</span>
          <Link href={`/projects/${project.id}`} className="hover:text-content">
            {project.name}
          </Link>
          <span>/</span>
          <span className="text-content-muted">Settings</span>
        </nav>

        <h1 className="text-lg font-semibold tracking-tight">Project settings</h1>
        <p className="mt-0.5 text-xs text-content-muted">{project.name}</p>

        <section className="panel mt-6">
          <div className="panel-header">
            <h2 className="panel-title">Agent permissions</h2>
            {canEdit ? (
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="btn-primary py-1 text-2xs"
              >
                {saving ? <Spinner className="h-3 w-3" /> : null}
                Save
              </button>
            ) : (
              <span className="text-2xs text-content-subtle">Admin role required to change</span>
            )}
          </div>

          <div className="px-4 py-4">
            <p className="mb-4 text-xs leading-relaxed text-content-muted">
              These determine what the agent may do on this project. They are independent of user
              roles: holding the owner role does not let the agent read production data.
            </p>

            <ul className="divide-y divide-surface-border">
              {Object.entries(permissions).map(([permission, granted]) => (
                <li key={permission} className="flex items-center justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <p className="font-mono text-xs">{permission}</p>
                    <p className="mt-0.5 text-2xs text-content-subtle">
                      {PERMISSION_NOTES[permission] ?? ''}
                    </p>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-2xs">
                    <input
                      type="checkbox"
                      checked={granted}
                      disabled={!canEdit}
                      onChange={(event) =>
                        setPermissions((previous) => ({
                          ...previous,
                          [permission]: event.target.checked,
                        }))
                      }
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    <span className={granted ? 'text-state-success' : 'text-content-subtle'}>
                      {granted ? 'granted' : 'denied'}
                    </span>
                  </label>
                </li>
              ))}

              {NEVER_GRANTABLE.map((capability) => (
                <li
                  key={capability}
                  className="flex items-center justify-between gap-4 py-2.5 opacity-60"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs">{capability}</p>
                    <p className="mt-0.5 text-2xs text-content-subtle">
                      Never grantable. The agent is refused this capability by design.
                    </p>
                  </div>
                  <span className="shrink-0 text-2xs text-state-failure">always denied</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {notice ? (
          <div className="mt-4">
            <Alert tone="success">{notice}</Alert>
          </div>
        ) : null}
        {error ? (
          <div className="mt-4">
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}

        <section className="panel mt-5">
          <div className="panel-header">
            <h2 className="panel-title">Environments</h2>
          </div>
          <div className="px-4 py-4">
            {environments.length === 0 ? (
              <p className="text-xs text-content-muted">
                No environments declared, so no task can run. Add one through the API or by
                recreating the project.
              </p>
            ) : (
              <ul className="space-y-2">
                {environments.map((environment) => (
                  <li key={environment.id} className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">{environment.name}</span>
                    <span className="font-mono text-2xs text-content-subtle">
                      {environment.branch}
                    </span>
                    <EnvironmentKindBadge kind={environment.kind} />
                    {environment.isDefaultTarget ? (
                      <span className="text-2xs text-content-subtle">default target</span>
                    ) : null}
                    {environment.kind === 'production' ? (
                      <span className="text-2xs text-state-failure">not targetable</span>
                    ) : null}
                    {environment.kind !== 'production' &&
                    !environment.isDefaultTarget &&
                    canEdit ? (
                      <button
                        type="button"
                        onClick={() => void makeDefault(environment.id)}
                        disabled={saving}
                        className="text-2xs font-medium text-accent hover:underline disabled:opacity-40"
                      >
                        Make default
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-2xs text-content-subtle">
              On Odoo.sh an environment is a branch. A task may target a staging or development
              environment; one marked production is refused, because that branch is the live
              business.
            </p>
            {canEdit ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void addEnvironment();
                }}
                className="mt-4 border-t border-surface-border pt-4"
              >
                <p className="field-label">Add an environment</p>
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  <input
                    aria-label="Environment name"
                    value={newEnvironment.name}
                    onChange={(event) =>
                      setNewEnvironment((previous) => ({ ...previous, name: event.target.value }))
                    }
                    placeholder="staging"
                    disabled={saving}
                    className="field-input w-40 text-xs"
                  />
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
                      className="field-input w-48 font-mono text-xs"
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
                      className="field-input w-48 font-mono text-xs"
                    />
                  )}
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
                    className="field-input w-36 text-xs"
                  >
                    <option value="development">Development</option>
                    <option value="staging">Staging</option>
                    <option value="production">Production</option>
                  </select>
                  <button
                    type="submit"
                    disabled={
                      saving ||
                      newEnvironment.name.trim() === '' ||
                      newEnvironment.branch.trim() === ''
                    }
                    className="btn-secondary"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => void readBranches()}
                    disabled={saving || readingBranches}
                    className="btn-ghost whitespace-nowrap px-3 text-2xs"
                  >
                    {readingBranches ? 'Reading' : 'Read branches'}
                  </button>
                </div>
                <p className="mt-1.5 text-2xs text-content-subtle">
                  {branches
                    ? `Picking from the ${branches.length} branch${branches.length === 1 ? '' : 'es'} the repository has.`
                    : 'Branch names are case-sensitive: read the branches to pick one that exists.'}
                </p>
                {environments.length === 0 ? (
                  <p className="mt-2 text-2xs text-state-waiting">
                    This project has no environments, so no task can run against it. Add the
                    branch you want the agent to work on.
                  </p>
                ) : null}
              </form>
            ) : null}
          </div>
        </section>

        {capabilities ? (
          <section className="panel mt-5">
            <div className="panel-header">
              <h2 className="panel-title">Pushing</h2>
            </div>
            <div className="px-4 py-4">
              <p className="text-xs">
                {capabilities.git.pushEnabled ? 'Enabled on this server' : 'Disabled on this server'}
              </p>
              <p className="mt-2 text-2xs text-content-subtle">{capabilities.git.pushReason}</p>
            </div>
          </section>
        ) : null}

        <section className="panel mt-5">
          <div className="panel-header">
            <h2 className="panel-title">Connections</h2>
          </div>
          {project.connections.length === 0 ? (
            <p className="px-4 py-5 text-xs text-content-muted">
              No connection configured. Add one when creating a project, or through the API.
            </p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {project.connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <p className="text-xs font-medium">{humanise(connection.connectionType)}</p>
                    <p className="mt-0.5 text-2xs text-content-subtle">
                      {connection.hasCredentials
                        ? 'Credential held, encrypted under a key unique to this project'
                        : 'No credential held'}
                    </p>
                  </div>
                  <span className="text-2xs text-content-subtle">
                    {humanise(connection.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel mt-5 border-state-failure/30">
          <div className="panel-header">
            <h2 className="panel-title text-state-failure">Removing this project</h2>
          </div>

          <div className="space-y-5 px-4 py-5">
            <div>
              <p className="text-xs font-medium">
                {project.archivedAt ? 'Archived' : 'Archive'}
              </p>
              <p className="mt-1 text-2xs text-content-subtle">
                {project.archivedAt
                  ? `Archived ${relativeTime(project.archivedAt)}. It is hidden from the ` +
                    'project list and cannot accept new tasks. Nothing has been deleted.'
                  : 'Hides it from the project list and stops it accepting new tasks. ' +
                    'Nothing is deleted, and it can be restored at any time.'}
              </p>

              {canEdit ? (
                <button
                  type="button"
                  onClick={() => void (project.archivedAt ? restore() : archive())}
                  disabled={busy}
                  className="btn-secondary mt-2.5"
                >
                  {busy ? <Spinner /> : null}
                  {project.archivedAt ? 'Restore project' : 'Archive project'}
                </button>
              ) : null}
            </div>

            <div className="border-t border-surface-border pt-4">
              <p className="text-xs font-medium text-state-failure">Delete permanently</p>
              <p className="mt-1 text-2xs text-content-subtle">
                Removes the project and everything it owns: every task and its diffs, the
                approval history, the environments, the connections and any stored credential.
                This cannot be undone.
              </p>
              <p className="mt-1.5 text-2xs text-content-subtle">
                The repository itself is untouched — this platform never pushes to it, and
                deleting a project here changes nothing on GitHub or Odoo.sh.
              </p>

              {isOwner ? (
                <div className="mt-3 space-y-2">
                  <label htmlFor="confirmName" className="block text-2xs text-content-subtle">
                    Type <span className="font-mono text-content">{project.name}</span> to
                    confirm
                  </label>
                  <input
                    id="confirmName"
                    value={confirmName}
                    onChange={(event) => setConfirmName(event.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    placeholder={project.name}
                    className="field-input font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void destroy()}
                    disabled={busy || confirmName.trim() !== project.name}
                    className="btn-danger"
                  >
                    {busy ? <Spinner /> : null}
                    Delete this project permanently
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-2xs text-content-subtle">
                  Only an organisation owner can delete a project permanently.
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
