'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import {
  defaultEnvironments,
  EnvironmentEditor,
  type EnvironmentDraft,
} from '@/components/projects/environment-editor';

const ODOO_VERSIONS = ['15.0', '16.0', '17.0', '18.0', '19.0'];

type Flow = 'connect' | 'ai';

/**
 * The two documented creation flows, chosen first and then completed.
 *
 * They are separate forms rather than one form with conditional fields, because
 * they collect different things for different reasons: connecting needs a
 * repository and a branch, while specifying needs a description and requirements
 * that become a persisted project specification.
 */
export default function NewProjectPage() {
  const { loading, user, organization } = useRequireAuth();
  const [flow, setFlow] = useState<Flow | null>(null);

  if (loading || !user) return <PageLoading />;

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-5 py-7">
        <h1 className="text-lg font-semibold tracking-tight">New project</h1>
        <p className="mt-0.5 text-xs text-content-muted">
          Creating in {organization?.organizationName}
        </p>

        {flow === null ? (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <FlowCard
              title="Connect an existing project"
              description="Point the platform at a Git repository or an Odoo.sh project you already have. The agent works on a branch and never on your default branch."
              onSelect={() => setFlow('connect')}
            />
            <FlowCard
              title="Create a new project with AI"
              description="Describe what the project must do and list its requirements. The platform records a structured specification that the agent works from."
              onSelect={() => setFlow('ai')}
            />
          </div>
        ) : (
          <div className="mt-6">
            <button
              type="button"
              onClick={() => setFlow(null)}
              className="btn-ghost mb-4 px-0 text-xs"
            >
              Back to both options
            </button>
            {flow === 'connect' ? (
              <ConnectExistingForm organizationId={organization?.organizationId ?? ''} />
            ) : (
              <CreateWithAiForm organizationId={organization?.organizationId ?? ''} />
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function FlowCard({
  title,
  description,
  onSelect,
}: {
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="panel p-5 text-left transition-colors hover:border-accent"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-2 text-xs leading-relaxed text-content-muted">{description}</p>
      <p className="mt-4 text-2xs font-medium text-accent">Choose this</p>
    </button>
  );
}

function ConnectExistingForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  // Seeded with no branch names: the staging and development guesses were the
  // cause of a project whose every task failed on a missing branch. Reading the
  // repository fills them in.
  const [environments, setEnvironments] = useState<EnvironmentDraft[]>(
    defaultEnvironments('main', []),
  );
  const [form, setForm] = useState({
    name: '',
    description: '',
    projectType: 'repository',
    odooVersion: '18.0',
    defaultBranch: 'main',
    repositoryUrl: '',
    credential: '',
    connectionType: 'github',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [branches, setBranches] = useState<string[] | undefined>(undefined);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  // On-premise: the folders a project may be pointed at, read once the type is
  // chosen. `onPremiseRoot` is undefined until read, null when disabled, and a
  // string when enabled.
  const [onPremiseRoot, setOnPremiseRoot] = useState<string | null | undefined>(undefined);
  const [onPremiseFolders, setOnPremiseFolders] = useState<
    { name: string; path: string; isGitRepository: boolean }[]
  >([]);
  const [onPremisePath, setOnPremisePath] = useState('');

  useEffect(() => {
    if (form.projectType !== 'on_premise') return;

    let cancelled = false;
    setOnPremiseRoot(undefined);

    (async () => {
      try {
        const { root, folders } = await api.projects.onPremiseLocations(organizationId);
        if (cancelled) return;
        setOnPremiseRoot(root);
        setOnPremiseFolders(folders);
        setOnPremisePath((previous) => previous || (folders[0]?.path ?? ''));
      } catch (caught) {
        if (cancelled) return;
        setOnPremiseRoot(null);
        setOnPremiseFolders([]);
        setError(caught instanceof ApiError ? caught.message : 'The folders could not be read.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [form.projectType, organizationId]);

  /**
   * Asks the repository which branches it has, so the environments below are
   * picked rather than typed. Git refs are case-sensitive, and a typed
   * `staging` against a repository whose branch is `Staging` produces a project
   * whose every task fails at clone time.
   *
   * A failure here is not fatal: the branch fields stay typeable, because a
   * repository the platform cannot reach yet must not block creating a project.
   */
  const readBranches = async () => {
    setReading(true);
    setBranchError(null);

    try {
      const { branches: found } = await api.projects.remoteBranchesFor({
        organizationId,
        repositoryUrl: form.repositoryUrl,
      });

      setBranches(found);
      setEnvironments(defaultEnvironments(form.defaultBranch, found));
    } catch (caught) {
      setBranches(undefined);
      setBranchError(
        caught instanceof ApiError ? caught.message : 'The branches could not be read.',
      );
    } finally {
      setReading(false);
    }
  };

  const update =
    (field: keyof typeof form) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const { value } = event.target;
      setForm((previous) => ({ ...previous, [field]: value }));

      // The production environment follows the default branch until someone
      // edits it, so the common case needs no second entry of the same name.
      if (field === 'defaultBranch') {
        setEnvironments((previous) =>
          previous.map((row) =>
            row.kind === 'production' && row.name === 'production'
              ? { ...row, branch: value }
              : row,
          ),
        );
      }
    };

  const needsRepository = form.projectType === 'repository' || form.projectType === 'odoo_sh';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    if (form.projectType === 'on_premise' && onPremisePath.trim().length === 0) {
      setError('Select the project folder the agent should operate on.');
      setSubmitting(false);
      return;
    }

    try {
      const project = await api.projects.create({
        organizationId,
        name: form.name,
        description: form.description || undefined,
        projectType: form.projectType,
        odooVersion: form.odooVersion,
        defaultBranch: form.defaultBranch,
        repositoryUrl: needsRepository ? form.repositoryUrl : undefined,
        // The selected on-premise directory, stored in the project's environment
        // configuration and enforced by the workspace layer at task time.
        environmentConfig:
          form.projectType === 'on_premise' ? { onPremisePath } : undefined,
        // Sent only where branches mean something. Blank rows are dropped rather
        // than rejected: a half-filled row is a person still typing.
        environments: needsRepository
          ? environments
              .filter((row) => row.name.trim() && row.branch.trim())
              .map((row) => ({
                name: row.name.trim(),
                branch: row.branch.trim(),
                kind: row.kind,
              }))
          : undefined,
      });

      // The credential is sent separately, so it never travels in a project
      // payload and is sealed by the secrets provider on arrival.
      if (form.credential.trim().length > 0) {
        await api.projects.createConnection(project.id, {
          connectionType: form.connectionType,
          credential: form.credential,
          metadata: { repositoryUrl: form.repositoryUrl },
        });
      }

      router.push(`/projects/${project.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The project could not be created.');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel space-y-5 p-6">
      <h2 className="text-sm font-semibold">Connect an existing project</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="name" className="field-label">
            Project name
          </label>
          <input id="name" required value={form.name} onChange={update('name')} className="field-input" />
        </div>

        <div>
          <label htmlFor="projectType" className="field-label">
            Project type
          </label>
          <select
            id="projectType"
            value={form.projectType}
            onChange={update('projectType')}
            className="field-input"
          >
            <option value="repository">Git repository</option>
            <option value="odoo_sh">Odoo.sh</option>
            <option value="on_premise">On-premise</option>
            <option value="odoo_online">Odoo Online</option>
          </select>
        </div>

        <div>
          <label htmlFor="odooVersion" className="field-label">
            Odoo version
          </label>
          <select
            id="odooVersion"
            value={form.odooVersion}
            onChange={update('odooVersion')}
            className="field-input"
          >
            {ODOO_VERSIONS.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </div>

        {needsRepository ? (
          <>
            <div className="sm:col-span-2">
              <label htmlFor="repositoryUrl" className="field-label">
                Repository URL
              </label>
              <div className="flex gap-2">
                <input
                  id="repositoryUrl"
                  required
                  value={form.repositoryUrl}
                  onChange={update('repositoryUrl')}
                  className="field-input flex-1 font-mono text-xs"
                  placeholder="https://github.com/organisation/repository.git"
                />
                <button
                  type="button"
                  onClick={readBranches}
                  disabled={reading || submitting || form.repositoryUrl.trim().length === 0}
                  className="btn-ghost whitespace-nowrap px-3 text-xs"
                >
                  {reading ? <Spinner /> : null}
                  {reading ? 'Reading' : 'Read branches'}
                </button>
              </div>
              {branchError ? (
                <p className="mt-1.5 text-2xs text-state-failure">
                  {branchError} The branch fields below stay typeable.
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="defaultBranch" className="field-label">
                Default branch
              </label>
              <input
                id="defaultBranch"
                value={form.defaultBranch}
                onChange={update('defaultBranch')}
                className="field-input font-mono text-xs"
              />
              <p className="mt-1.5 text-2xs text-content-subtle">
                The agent branches from this and never commits to it directly.
              </p>
            </div>

            <EnvironmentEditor
              value={environments}
              onChange={setEnvironments}
              disabled={submitting}
              branches={branches}
            />

            <div>
              <label htmlFor="connectionType" className="field-label">
                Git provider
              </label>
              <select
                id="connectionType"
                value={form.connectionType}
                onChange={update('connectionType')}
                className="field-input"
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="credential" className="field-label">
                Access token (optional)
              </label>
              <input
                id="credential"
                type="password"
                value={form.credential}
                onChange={update('credential')}
                className="field-input font-mono text-xs"
                placeholder="Leave blank to add later"
              />
              <p className="mt-1.5 text-2xs text-content-subtle">
                Encrypted under a key unique to this project and stored by reference. It is never
                returned by the API, written to a log, or sent to an AI provider.
              </p>
            </div>
          </>
        ) : null}

        {form.projectType === 'on_premise' ? (
          <div className="sm:col-span-2">
            <label htmlFor="onPremisePath" className="field-label">
              Project folder
            </label>
            {onPremiseRoot === undefined ? (
              <p className="mt-1.5 text-2xs text-content-subtle">Reading available folders…</p>
            ) : onPremiseRoot === null ? (
              <p className="mt-1.5 text-2xs text-state-failure">
                On-premise execution is not configured on this server. Ask an operator to set
                ON_PREMISE_ROOT.
              </p>
            ) : onPremiseFolders.length === 0 ? (
              <p className="mt-1.5 text-2xs text-content-subtle">
                No folders were found under the configured root.
              </p>
            ) : (
              <select
                id="onPremisePath"
                value={onPremisePath}
                onChange={(event) => setOnPremisePath(event.target.value)}
                className="field-input font-mono text-xs"
                required
              >
                {onPremiseFolders.map((folder) => (
                  <option key={folder.path} value={folder.path}>
                    {folder.name}
                    {folder.isGitRepository ? '' : ' (not a Git repository)'}
                  </option>
                ))}
              </select>
            )}
            <p className="mt-1.5 text-2xs text-content-subtle">
              The agent operates directly on this directory and never modifies the shared Odoo base
              or enterprise addons.
            </p>
          </div>
        ) : null}

        <div className="sm:col-span-2">
          <label htmlFor="description" className="field-label">
            Description (optional)
          </label>
          <textarea
            id="description"
            rows={3}
            value={form.description}
            onChange={update('description')}
            className="field-input resize-none"
          />
        </div>
      </div>

      {form.projectType === 'odoo_online' ? (
        <Alert tone="warning" title="Not yet reachable by the agent">
          Odoo Online requires the integration service, which arrives in a later phase; the project
          can be recorded now.
        </Alert>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? <Spinner /> : null}
          {submitting ? 'Creating' : 'Create project'}
        </button>
      </div>
    </form>
  );
}

function CreateWithAiForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [odooVersion, setOdooVersion] = useState('18.0');
  const [description, setDescription] = useState('');
  const [requirements, setRequirements] = useState<{ title: string; detail: string }[]>([
    { title: '', detail: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setRequirement = (index: number, field: 'title' | 'detail', value: string) =>
    setRequirements((previous) =>
      previous.map((entry, position) =>
        position === index ? { ...entry, [field]: value } : entry,
      ),
    );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const populated = requirements
      .map((entry) => ({ title: entry.title.trim(), detail: entry.detail.trim() }))
      .filter((entry) => entry.title.length > 0);

    if (populated.length === 0) {
      setError('Add at least one requirement. The specification is what the agent works from.');
      return;
    }

    setSubmitting(true);
    try {
      const project = await api.projects.createWithAi({
        organizationId,
        name,
        odooVersion,
        description,
        requirements: populated.map((entry) => ({
          title: entry.title,
          detail: entry.detail.length > 0 ? entry.detail : undefined,
        })),
      });
      router.push(`/projects/${project.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The project could not be created.');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel space-y-5 p-6">
      <div>
        <h2 className="text-sm font-semibold">Create a new project with AI</h2>
        <p className="mt-1 text-xs text-content-muted">
          These four inputs become a structured project specification, held as a versioned record so
          that project context does not depend on conversation history.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label htmlFor="ai-name" className="field-label">
            Project name
          </label>
          <input
            id="ai-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="field-input"
            placeholder="Equipment Management"
          />
        </div>

        <div>
          <label htmlFor="ai-version" className="field-label">
            Odoo version
          </label>
          <select
            id="ai-version"
            value={odooVersion}
            onChange={(event) => setOdooVersion(event.target.value)}
            className="field-input"
          >
            {ODOO_VERSIONS.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="ai-description" className="field-label">
          What must the project do?
        </label>
        <textarea
          id="ai-description"
          required
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="field-input resize-none"
          placeholder="Manage employee equipment: issue, track and return company assets."
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="field-label mb-0">Initial requirements</span>
          <button
            type="button"
            onClick={() => setRequirements((previous) => [...previous, { title: '', detail: '' }])}
            className="btn-ghost px-2 py-1 text-2xs"
          >
            Add requirement
          </button>
        </div>

        <div className="space-y-2">
          {requirements.map((requirement, index) => (
            <div key={index} className="rounded-md border border-surface-border bg-surface p-3">
              <div className="flex items-start gap-2">
                <span className="mt-2 font-mono text-2xs text-content-subtle">
                  REQ-{String(index + 1).padStart(3, '0')}
                </span>
                <div className="flex-1 space-y-2">
                  <input
                    value={requirement.title}
                    onChange={(event) => setRequirement(index, 'title', event.target.value)}
                    className="field-input py-1.5 text-xs"
                    placeholder="Register equipment against an employee"
                  />
                  <input
                    value={requirement.detail}
                    onChange={(event) => setRequirement(index, 'detail', event.target.value)}
                    className="field-input py-1.5 text-xs"
                    placeholder="Detail (optional)"
                  />
                </div>
                {requirements.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setRequirements((previous) =>
                        previous.filter((_, position) => position !== index),
                      )
                    }
                    className="btn-ghost mt-1 px-2 py-1 text-2xs"
                    aria-label={`Remove requirement ${index + 1}`}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Alert tone="info" title="No repository yet">
        A project created this way has no repository, so the agent can analyse and plan but cannot
        commit. Connect a repository from the project settings when one exists.
      </Alert>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex justify-end border-t border-surface-border pt-4">
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? <Spinner /> : null}
          {submitting ? 'Creating' : 'Create project and specification'}
        </button>
      </div>
    </form>
  );
}
