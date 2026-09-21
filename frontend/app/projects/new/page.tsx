'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import { USER_REGIONS, USER_REGION_LABELS, type UserRegion } from '@/lib/types';
import {
  defaultEnvironments,
  EnvironmentEditor,
  type EnvironmentDraft,
} from '@/components/projects/environment-editor';
import { ModulePicker } from '@/components/projects/module-picker';

const ODOO_VERSIONS = ['15.0', '16.0', '17.0', '18.0', '19.0'];
const ODOO_EDITIONS: { value: string; label: string }[] = [
  { value: 'enterprise', label: 'Enterprise' },
  { value: 'community', label: 'Community' },
];

/**
 * The database name an Odoo Online URL implies.
 *
 * On odoo.com the database is the subdomain, so asking for it separately asks a
 * person to retype what the URL already says - and getting it wrong produces an
 * authentication failure that names nothing they did. Offered as a default here
 * and defaulted again on the server, which is the authority.
 */
function databaseFromOdooUrl(url: string): string {
  try {
    const host = new URL(url.trim()).hostname;
    const [subdomain, ...rest] = host.split('.');
    return rest.length >= 2 ? subdomain : '';
  } catch {
    return '';
  }
}

/**
 * True when a repository URL names an SSH remote — either the `ssh://` scheme
 * or git's scp-like `git@host:path` form, which has no scheme at all.
 *
 * Worth a function because the two forms look nothing alike, and telling them
 * apart decides whether the credential is presented as a token or a key.
 */
function usesSshRemote(repositoryUrl: string): boolean {
  const trimmed = repositoryUrl.trim();
  if (trimmed.startsWith('ssh://')) return true;
  // scp-like: user@host:path, with no scheme and no slash before the colon.
  return /^[^/@\s]+@[^/:\s]+:/.test(trimmed);
}

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
  const { loading, user } = useRequireAuth();
  const [flow, setFlow] = useState<Flow | null>(null);

  if (loading || !user) return <PageLoading />;

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-5 py-7">
        <h1 className="text-lg font-semibold tracking-tight">New project</h1>
        <p className="mt-0.5 text-xs text-content-muted">
          Creating in {USER_REGION_LABELS[user.region]}
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
              <ConnectExistingForm region={user.region} isAdmin={user.isAdmin} />
            ) : (
              <CreateWithAiForm region={user.region} isAdmin={user.isAdmin} />
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

/**
 * Which region the project belongs to (ADR-044). A regular user may only create
 * in their own region, so for them this is a fixed label rather than a choice;
 * an administrator may create anywhere. The server refuses anything else.
 */
function RegionField({
  region,
  isAdmin,
  onChange,
}: {
  region: UserRegion;
  isAdmin: boolean;
  onChange: (region: UserRegion) => void;
}) {
  if (!isAdmin) {
    return (
      <div>
        <span className="field-label">Region</span>
        <p className="field-input flex items-center text-content-muted">
          {USER_REGION_LABELS[region]}
        </p>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="region" className="field-label">
        Region
      </label>
      <select
        id="region"
        value={region}
        onChange={(event) => onChange(event.target.value as UserRegion)}
        className="field-input"
      >
        {USER_REGIONS.map((value) => (
          <option key={value} value={value}>
            {USER_REGION_LABELS[value]}
          </option>
        ))}
      </select>
    </div>
  );
}

function ConnectExistingForm({ region, isAdmin }: { region: UserRegion; isAdmin: boolean }) {
  const router = useRouter();
  const [regionChoice, setRegionChoice] = useState<UserRegion>(region);
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
    odooEdition: 'enterprise',
    defaultBranch: 'main',
    repositoryUrl: '',
    credential: '',
    connectionType: 'github',
    // ADR-050/ADR-054: the linked instance this connect points at (the
    // customer's own odoo.sh/on-premise project), so a restore can later be
    // aimed at its database manager. Never used to create a repository.
    projectUrl: '',
    projectDatabase: '',
    isOdoosh: false,
  });

  // Odoo Online: the four things needed to reach an instance. The API key is
  // sealed by the secrets provider on arrival and never comes back from the API.
  const [odooOnline, setOdooOnline] = useState({
    url: '',
    db: '',
    login: '',
    apiKey: '',
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
        const { root, folders } = await api.projects.onPremiseLocations();
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
  }, [form.projectType]);

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
      // A private repository cannot be read without a credential, and no
      // connection exists yet to hold one (ADR-021) — the token/key typed
      // into the form below is sent for this one probe and never stored here.
      // The kind follows the URL's own scheme: an `ssh://` or `git@host:path`
      // remote is reached with a key, everything else with an HTTPS token.
      const { branches: found } = await api.projects.remoteBranchesFor({
        repositoryUrl: form.repositoryUrl,
        credential: form.credential.trim().length > 0 ? form.credential.trim() : undefined,
        credentialKind: usesSshRemote(form.repositoryUrl) ? 'ssh_key' : 'token',
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

  /**
   * Whether the form asks for a repository.
   *
   * `on_premise` is included (ADR-049, ADR-050): an on-premise project either
   * points at a directory on this host, or — when the customer's Odoo is on
   * another server — at the repository the platform changes and pushes, with the
   * customer's host pulling for itself. Supplying both is allowed; supplying
   * neither is not, and is refused at submit.
   */
  const needsRepository =
    form.projectType === 'repository' ||
    form.projectType === 'odoo_sh' ||
    form.projectType === 'on_premise';
  const isOdooOnline = form.projectType === 'odoo_online';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    // An on-premise project needs a local folder OR a repository (ADR-050): a
    // folder when Cartenz runs beside the Odoo, a repository when it does not.
    if (
      form.projectType === 'on_premise' &&
      onPremisePath.trim().length === 0 &&
      form.repositoryUrl.trim().length === 0
    ) {
      setError(
        'Select a project folder, or give the repository this project is deployed from.',
      );
      setSubmitting(false);
      return;
    }

    // Refused here rather than after the project row exists: a project created
    // without its credentials is one whose every task fails at the first read.
    if (isOdooOnline) {
      const missing = (['url', 'login', 'apiKey'] as const).filter(
        (field) => odooOnline[field].trim().length === 0,
      );
      if (missing.length > 0) {
        setError('An Odoo Online project needs its URL, login and API key.');
        setSubmitting(false);
        return;
      }
    }

    try {
      const project = await api.projects.create({
        region: regionChoice,
        name: form.name,
        description: form.description || undefined,
        projectType: form.projectType,
        odooVersion: form.odooVersion,
        odooEdition: form.odooEdition,
        defaultBranch: form.defaultBranch,
        // Blank means "no repository", not "an empty one": an on-premise
        // project may be a directory that is not a checkout of anything
        // (ADR-026), and an empty string stored where a URL belongs reads as a
        // repository that failed to load rather than one that was never given.
        repositoryUrl:
          needsRepository && form.repositoryUrl.trim().length > 0
            ? form.repositoryUrl.trim()
            : undefined,
        // The selected on-premise directory, stored in the project's environment
        // configuration and enforced by the workspace layer at task time. Absent
        // when the project is repo-backed instead (ADR-050): the clone supplies
        // the code and no local directory is involved.
        environmentConfig:
          form.projectType === 'on_premise' && onPremisePath.trim().length > 0
            ? { onPremisePath }
            : undefined,
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
        // ADR-050/ADR-054: the customer's own odoo.sh/on-premise instance this
        // connect points at, so a later restore reaches its database manager.
        // Never a repository - a repository-backed project still pulls from
        // `repositoryUrl` above exactly as before.
        projectUrl: form.projectUrl.trim().length > 0 ? form.projectUrl.trim() : undefined,
        projectDatabase:
          form.projectDatabase.trim().length > 0 ? form.projectDatabase.trim() : undefined,
        isOdoosh: form.isOdoosh || undefined,
      });

      // The credential is sent separately, so it never travels in a project
      // payload and is sealed by the secrets provider on arrival.
      if (isOdooOnline) {
        await api.projects.createConnection(project.id, {
          connectionType: 'odoo_api',
          credential: odooOnline.apiKey.trim(),
          // The database defaults to the subdomain, which is what it is on
          // odoo.com. The field stays editable for an instance where it differs.
          metadata: {
            url: odooOnline.url.trim(),
            db: odooOnline.db.trim() || databaseFromOdooUrl(odooOnline.url),
            login: odooOnline.login.trim(),
          },
        });
      } else if (form.credential.trim().length > 0) {
        await api.projects.createConnection(project.id, {
          connectionType: form.connectionType,
          credential: form.credential,
          // Sent explicitly so an SSH key is not stored as a token (ADR-021):
          // the kind decides whether the credential is handed to ssh or to the
          // HTTPS askpass helper, and only the form knows which was pasted.
          credentialKind: usesSshRemote(form.repositoryUrl) ? 'ssh_key' : 'token',
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
        <div>
          <label htmlFor="name" className="field-label">
            Project name
          </label>
          <input id="name" required value={form.name} onChange={update('name')} className="field-input" />
        </div>

        <RegionField region={regionChoice} isAdmin={isAdmin} onChange={setRegionChoice} />

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

        <div>
          <label htmlFor="odooEdition" className="field-label">
            Odoo edition
          </label>
          <select
            id="odooEdition"
            value={form.odooEdition}
            onChange={update('odooEdition')}
            className="field-input"
          >
            {ODOO_EDITIONS.map((edition) => (
              <option key={edition.value} value={edition.value}>
                {edition.label}
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
                  required={form.projectType !== 'on_premise'}
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
                {usesSshRemote(form.repositoryUrl) ? 'SSH private key (optional)' : 'Access token (optional)'}
              </label>
              {usesSshRemote(form.repositoryUrl) ? (
                // A private key spans multiple lines, and a single-line <input> silently
                // drops the newlines a paste carries — the key still "looks" pasted but
                // OpenSSH then fails with "error in libcrypto" on an unparsable PEM body.
                // A <textarea> keeps every line break the clipboard held.
                <textarea
                  id="credential"
                  value={form.credential}
                  onChange={update('credential')}
                  className="field-input font-mono text-xs"
                  rows={6}
                  spellCheck={false}
                  placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'}
                />
              ) : (
                <input
                  id="credential"
                  type="password"
                  value={form.credential}
                  onChange={update('credential')}
                  className="field-input font-mono text-xs"
                  placeholder="Leave blank to add later"
                />
              )}
              <p className="mt-1.5 text-2xs text-content-subtle">
                Encrypted under a key unique to this project and stored by reference. It is never
                returned by the API, written to a log, or sent to an AI provider. Also used to read
                branches from a private repository above, for this one check only.
              </p>
            </div>
          </>
        ) : null}

        {isOdooOnline ? (
          <>
            <div className="sm:col-span-2">
              <label htmlFor="odooUrl" className="field-label">
                Instance URL
              </label>
              <input
                id="odooUrl"
                required
                value={odooOnline.url}
                onChange={(event) =>
                  setOdooOnline((previous) => ({ ...previous, url: event.target.value }))
                }
                className="field-input font-mono text-xs"
                placeholder="https://your-instance.odoo.com"
              />
              <p className="mt-1.5 text-2xs text-content-subtle">
                The instance address. A trailing /odoo or /web copied from the browser is removed.
              </p>
            </div>

            <div>
              <label htmlFor="odooLogin" className="field-label">
                User
              </label>
              <input
                id="odooLogin"
                required
                value={odooOnline.login}
                onChange={(event) =>
                  setOdooOnline((previous) => ({ ...previous, login: event.target.value }))
                }
                className="field-input font-mono text-xs"
                placeholder="you@example.com"
              />
              <p className="mt-1.5 text-2xs text-content-subtle">
                The login the API key belongs to, usually an email address.
              </p>
            </div>

            <div>
              <label htmlFor="odooDb" className="field-label">
                Database (optional)
              </label>
              <input
                id="odooDb"
                value={odooOnline.db}
                onChange={(event) =>
                  setOdooOnline((previous) => ({ ...previous, db: event.target.value }))
                }
                className="field-input font-mono text-xs"
                placeholder={databaseFromOdooUrl(odooOnline.url) || 'from the URL'}
              />
              <p className="mt-1.5 text-2xs text-content-subtle">
                Defaults to the subdomain of the URL, which is the database name on odoo.com.
              </p>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="odooApiKey" className="field-label">
                API key
              </label>
              <input
                id="odooApiKey"
                type="password"
                required
                value={odooOnline.apiKey}
                onChange={(event) =>
                  setOdooOnline((previous) => ({ ...previous, apiKey: event.target.value }))
                }
                className="field-input font-mono text-xs"
                autoComplete="off"
              />
              <p className="mt-1.5 text-2xs text-content-subtle">
                Generated in Odoo under Preferences, Account Security. Encrypted under a key unique
                to this project and stored by reference. It is never returned by the API, written to
                a log, or sent to an AI provider.
              </p>
            </div>
          </>
        ) : null}

        {needsRepository ? (
          <div className="sm:col-span-2 rounded-md border border-border-subtle p-3">
            <p className="field-label mb-2">
              Linked instance (optional)
            </p>
            <p className="mb-3 text-2xs text-content-subtle">
              Only needed when this connects to a customer&apos;s existing odoo.sh or
              on-premise instance: recorded so a restore can later be aimed at that
              instance&apos;s own database manager. This never creates a repository — the
              code still pulls from the Repository URL above (ADR-049, ADR-050).
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="projectUrl" className="field-label">
                  Instance URL
                </label>
                <input
                  id="projectUrl"
                  value={form.projectUrl}
                  onChange={update('projectUrl')}
                  className="field-input font-mono text-xs"
                  placeholder="https://testpurchase.masbintang.space"
                />
              </div>
              <div>
                <label htmlFor="projectDatabase" className="field-label">
                  Database name
                </label>
                <input
                  id="projectDatabase"
                  value={form.projectDatabase}
                  onChange={update('projectDatabase')}
                  className="field-input font-mono text-xs"
                  placeholder="testpurchase"
                />
              </div>
              <div className="flex items-end pb-1">
                <label htmlFor="isOdoosh" className="flex items-center gap-2 text-xs text-content-default">
                  <input
                    id="isOdoosh"
                    type="checkbox"
                    checked={form.isOdoosh}
                    onChange={(event) =>
                      setForm((previous) => ({ ...previous, isOdoosh: event.target.checked }))
                    }
                  />
                  This is an Odoo.sh instance
                </label>
              </div>
            </div>
          </div>
        ) : null}

        {form.projectType === 'on_premise' ? (
          <div className="sm:col-span-2">
            <label htmlFor="onPremisePath" className="field-label">
              Project folder
              {form.repositoryUrl.trim().length > 0 ? ' (optional)' : ''}
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
                required={form.repositoryUrl.trim().length === 0}
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
              {form.repositoryUrl.trim().length > 0
                ? 'A repository is given, so the platform changes the code in an isolated clone and pushes it; the customer’s own server pulls the branch. The folder is optional and used only when Cartenz runs beside the Odoo.'
                : 'The agent operates directly on this directory and never modifies the shared Odoo base or enterprise addons. Add a repository URL instead when the customer’s Odoo is on another server.'}
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

      {isOdooOnline ? (
        <Alert tone="warning" title="The agent changes this instance directly">
          There is no repository, no branch and no diff for an Odoo Online project. An approved
          change is created on the live instance, the way Odoo Studio does it, and undoing the task
          does not remove it.
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

function CreateWithAiForm({ region, isAdmin }: { region: UserRegion; isAdmin: boolean }) {
  const router = useRouter();
  const [regionChoice, setRegionChoice] = useState<UserRegion>(region);
  const [name, setName] = useState('');
  const [odooVersion, setOdooVersion] = useState('18.0');
  const [odooEdition, setOdooEdition] = useState('enterprise');
  const [description, setDescription] = useState('');
  const [requirements, setRequirements] = useState<{ title: string; detail: string }[]>([
    { title: '', detail: '' },
  ]);
  /**
   * ADR-056: which of the two install modes this project uses, and — when the
   * second is chosen — the modules ticked in the picker. `'all'` is the default
   * so the pre-ADR-056 behaviour is what an unmodified form submits.
   */
  const [installMode, setInstallMode] = useState<'all' | 'choose'>('all');
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
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

    if (installMode === 'choose' && selectedModules.length === 0) {
      setError('Choose at least one module, or switch back to "Install everything".');
      return;
    }

    setSubmitting(true);
    try {
      const project = await api.projects.createWithAi({
        region: regionChoice,
        name,
        odooVersion,
        odooEdition,
        description,
        requirements: populated.map((entry) => ({
          title: entry.title,
          detail: entry.detail.length > 0 ? entry.detail : undefined,
        })),
        modules: installMode === 'choose' ? selectedModules : undefined,
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

        <div>
          <label htmlFor="ai-edition" className="field-label">
            Odoo edition
          </label>
          <select
            id="ai-edition"
            value={odooEdition}
            onChange={(event) => setOdooEdition(event.target.value)}
            className="field-input"
          >
            {ODOO_EDITIONS.map((edition) => (
              <option key={edition.value} value={edition.value}>
                {edition.label}
              </option>
            ))}
          </select>
        </div>

        <RegionField region={regionChoice} isAdmin={isAdmin} onChange={setRegionChoice} />
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

      <div>
        <span className="field-label">Modules to install</span>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-surface-border bg-surface p-3">
            <input
              type="radio"
              name="install-mode"
              className="mt-0.5"
              checked={installMode === 'all'}
              onChange={() => setInstallMode('all')}
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium">Install everything</span>
              <span className="block text-2xs text-content-subtle">
                Every module this Odoo edition ships, ready to switch on per user. The fast
                path: the project is cloned from a pre-built database.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-surface-border bg-surface p-3">
            <input
              type="radio"
              name="install-mode"
              className="mt-0.5"
              checked={installMode === 'choose'}
              onChange={() => setInstallMode('choose')}
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium">Choose what to install</span>
              <span className="block text-2xs text-content-subtle">
                Pick only the apps this project needs. The instance starts small and is built
                in the background; dependencies are installed automatically.
              </span>
            </span>
          </label>
        </div>
      </div>

      {installMode === 'choose' ? (
        <ModulePicker
          version={odooVersion}
          edition={odooEdition}
          value={selectedModules}
          onChange={setSelectedModules}
        />
      ) : null}

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
