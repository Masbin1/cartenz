'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  Boxes,
  Cloud,
  FolderGit2,
  GitBranch,
  Globe,
  LayoutGrid,
  Lock,
  Plus,
  Server,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageHeader } from '@/components/ui/page';
import { Section } from '@/components/ui/section';
import { Disclosure } from '@/components/ui/disclosure';
import { Skeleton } from '@/components/ui/skeleton';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import { USER_REGIONS, USER_REGION_LABELS, type GitCredential, type UserRegion } from '@/lib/types';
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

  const chosen = flow ? FLOWS[flow] : null;

  return (
    <AppShell>
      <div className="page-narrow">
        <PageHeader
          back={{ href: '/projects', label: 'Projects' }}
          title="New project"
          description={chosen ? chosen.summary : 'Choose how to start.'}
          meta={
            <span className="text-meta text-content-subtle">
              Creating in {USER_REGION_LABELS[user.region]}
            </span>
          }
        />

        {flow === null ? (
          <div className="grid animate-rise-in gap-4 sm:grid-cols-2">
            <FlowTile flow={FLOWS.connect} onSelect={() => setFlow('connect')} />
            <FlowTile flow={FLOWS.ai} onSelect={() => setFlow('ai')} />
          </div>
        ) : (
          <div>
            {/*
             * The chosen starting point stays in view, compact, with the way back
             * beside it: the form below belongs to this choice only.
             */}
            {chosen ? (
              <div className="mb-12 flex items-center gap-4 rounded-xl border border-surface-border bg-surface-raised px-4 py-3">
                <FlowIcon icon={chosen.icon} />
                <div className="min-w-0 flex-1">
                  <p className="text-meta text-content-subtle">Starting point</p>
                  <p className="truncate text-callout font-semibold text-content">{chosen.title}</p>
                </div>
                <button type="button" onClick={() => setFlow(null)} className="btn-ghost btn-sm">
                  Change
                </button>
              </div>
            ) : null}
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

interface FlowOption {
  icon: LucideIcon;
  title: string;
  description: string;
  /** The page description once this flow is chosen. */
  summary: string;
}

const FLOWS: Record<Flow, FlowOption> = {
  connect: {
    icon: FolderGit2,
    title: 'Connect an existing project',
    description:
      'Point the platform at a Git repository or an Odoo.sh project you already have. The agent works on a branch, never on your default branch.',
    summary: 'Connect a repository or instance you already have.',
  },
  ai: {
    icon: Sparkles,
    title: 'Create a new project with AI',
    description:
      'Describe what the project must do and list its requirements. The platform records a structured specification that the agent works from.',
    summary: 'Describe the project; the platform records a specification the agent works from.',
  },
};

function FlowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-overlay text-content-muted"
      aria-hidden="true"
    >
      <Icon className="h-5 w-5" strokeWidth={1.75} />
    </span>
  );
}

/** One of the two starting points, as a generous tile. */
function FlowTile({ flow, onSelect }: { flow: FlowOption; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="panel group flex flex-col p-6 text-left transition-colors hover:border-surface-strong"
    >
      <FlowIcon icon={flow.icon} />
      <h2 className="mt-5 text-headline text-content">{flow.title}</h2>
      <p className="mt-2 flex-1 text-callout text-content-muted">{flow.description}</p>
      <span className="mt-6 inline-flex items-center gap-1.5 text-callout font-medium text-content-muted transition-colors group-hover:text-content">
        Continue
        <ArrowRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </span>
    </button>
  );
}

/**
 * A radio choice presented as a tile: icon, title, one line of description.
 * The input itself is visually hidden but stays in the tab order, so arrow keys
 * move through the group as they would through plain radios.
 */
function ChoiceTile({
  name,
  value,
  checked,
  onChange,
  icon: Icon,
  title,
  description,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3.5 rounded-xl border p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/60 ${
        checked
          ? 'border-accent/60 bg-accent-subtle ring-1 ring-accent/30'
          : 'border-surface-border bg-surface-raised hover:border-surface-strong'
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <Icon
        className={`mt-0.5 h-[18px] w-[18px] shrink-0 ${checked ? 'text-accent' : 'text-content-subtle'}`}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block text-callout font-semibold text-content">{title}</span>
        <span className="mt-0.5 block text-meta text-content-muted">{description}</span>
      </span>
    </label>
  );
}

const PROJECT_TYPES: { value: string; icon: LucideIcon; title: string; description: string }[] = [
  {
    value: 'repository',
    icon: GitBranch,
    title: 'Git repository',
    description: 'Any GitHub or GitLab repository.',
  },
  {
    value: 'odoo_sh',
    icon: Cloud,
    title: 'Odoo.sh',
    description: 'An Odoo.sh project and its repository.',
  },
  {
    value: 'on_premise',
    icon: Server,
    title: 'On-premise',
    description: 'A folder on this server, or a repository the customer’s server pulls.',
  },
  {
    value: 'odoo_online',
    icon: Globe,
    title: 'Odoo Online',
    description: 'A hosted instance, changed directly through its API.',
  },
];

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
        <p className="flex items-center gap-2 rounded-control border border-surface-border bg-surface-overlay/50 px-3.5 py-2.5 text-body text-content-muted">
          <Lock className="h-4 w-4 shrink-0 text-content-subtle" strokeWidth={1.75} aria-hidden="true" />
          {USER_REGION_LABELS[region]}
        </p>
        <p className="field-hint">Projects are created in your own region.</p>
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

  /**
   * Credentials registered in Settings (ADR-058), so this form does not ask for
   * the same SSH key every time. `chosen` is '' for "use the default", which is
   * resolved server-side and so needs no value here — that is what makes the
   * common case zero-input.
   */
  const [credentials, setCredentials] = useState<GitCredential[]>([]);
  const [chosenCredentialId, setChosenCredentialId] = useState('');
  /** Which credential actually read the branches, so the list can say so. */
  const [readingCredentialLabel, setReadingCredentialLabel] = useState<string | null>(null);

  const defaultCredential = credentials.find((entry) => entry.isDefault && entry.enabled) ?? null;
  const chosenCredential =
    credentials.find((entry) => entry.id === chosenCredentialId) ?? defaultCredential;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { credentials: rows } = await api.settings.gitCredentials();
        if (cancelled) return;
        // Only credentials that can actually be used: a disabled one is a
        // withdrawal, and offering it would promise something the server refuses.
        setCredentials(rows.filter((row) => row.enabled));
      } catch {
        // Not fatal: the form still works by pasting a value, which is the
        // behaviour before this feature existed.
        if (!cancelled) setCredentials([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
    setReadingCredentialLabel(null);

    try {
      /**
       * Precedence, and it has to match the server's (ADR-058): a value typed
       * into this form wins, because someone who pasted one meant to use it;
       * otherwise a credential registered in Settings is resolved server-side —
       * the chosen one, or the default. That is what makes the common case need
       * no credential typed here at all, and a key that is never retyped is a
       * key that cannot lose its line breaks in a paste.
       */
      const typed = form.credential.trim();
      const { branches: found, credentialLabel } = await api.projects.remoteBranchesFor({
        repositoryUrl: form.repositoryUrl,
        credential: typed.length > 0 ? typed : undefined,
        credentialKind: typed.length > 0
          ? usesSshRemote(form.repositoryUrl)
            ? 'ssh_key'
            : 'token'
          : undefined,
        credentialId: typed.length > 0 ? undefined : chosenCredentialId || undefined,
      });

      setBranches(found);
      setReadingCredentialLabel(credentialLabel);
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
      } else {
        /**
         * No value typed, so the connection attaches a credential registered in
         * Settings (ADR-058) — the chosen one, or the default whose host list
         * covers this remote. The connection then stores that credential's own
         * secret reference, so rotating it in Settings reaches this project
         * without anyone editing it here.
         *
         * Nothing is sent when there is no registered credential either: an empty
         * connection is a valid state (status `pending`), and inventing one would
         * make the project look connected when it is not.
         */
        const credentialId = chosenCredentialId || chosenCredential?.id || undefined;

        await api.projects.createConnection(project.id, {
          connectionType: form.connectionType,
          credentialId,
          // Sent explicitly so an SSH key is not stored as a token (ADR-021):
          // the kind decides whether the credential is handed to ssh or to the
          // HTTPS askpass helper. A registered credential's own kind wins
          // server-side, which is the case this branch exists for.
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
    <form onSubmit={submit} className="animate-rise-in space-y-10">
      <Section size="small" title="Project" description="What it is called and where it belongs.">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="name" className="field-label">
              Project name
            </label>
            <input id="name" required value={form.name} onChange={update('name')} className="field-input" />
          </div>

          <RegionField region={regionChoice} isAdmin={isAdmin} onChange={setRegionChoice} />

          <div className="sm:col-span-2">
            <label htmlFor="description" className="field-label">
              Description <span className="font-normal text-content-subtle">(optional)</span>
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
      </Section>

      <Section
        size="small"
        divided
        title="Hosting"
        description="Where the project runs, and the Odoo it targets."
      >
        <fieldset>
          <legend className="field-label">Project type</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {PROJECT_TYPES.map((type) => (
              <ChoiceTile
                key={type.value}
                name="projectType"
                value={type.value}
                checked={form.projectType === type.value}
                onChange={update('projectType')}
                icon={type.icon}
                title={type.title}
                description={type.description}
              />
            ))}
          </div>
        </fieldset>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
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
        </div>
      </Section>

      {form.projectType === 'on_premise' ? (
        <Section
          size="small"
          divided
          title="Project folder"
          description="A folder on this server, used when Cartenz runs beside the customer’s Odoo."
        >
          <label htmlFor="onPremisePath" className="field-label">
            Folder
            {form.repositoryUrl.trim().length > 0 ? (
              <span className="font-normal text-content-subtle"> (optional)</span>
            ) : null}
          </label>
          {onPremiseRoot === undefined ? (
            <div role="status" aria-label="Reading available folders">
              <Skeleton className="h-[46px] w-full rounded-control" />
            </div>
          ) : onPremiseRoot === null ? (
            <Alert tone="warning" title="On-premise execution is not configured">
              Ask an operator to set ON_PREMISE_ROOT on this server.
            </Alert>
          ) : onPremiseFolders.length === 0 ? (
            <p className="text-callout text-content-muted">
              No folders were found under the configured root.
            </p>
          ) : (
            <select
              id="onPremisePath"
              value={onPremisePath}
              onChange={(event) => setOnPremisePath(event.target.value)}
              className="field-input font-mono text-callout"
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
          <p className="field-hint">
            {form.repositoryUrl.trim().length > 0
              ? 'A repository is given, so the platform changes the code in an isolated clone and pushes it; the customer’s own server pulls the branch. The folder is optional and used only when Cartenz runs beside the Odoo.'
              : 'The agent works directly in this folder and never modifies the shared Odoo base or enterprise addons. Add a repository URL below instead when the customer’s Odoo is on another server.'}
          </p>
        </Section>
      ) : null}

      {needsRepository ? (
        <Section
          size="small"
          divided
          title="Repository"
          description="The code the agent changes, and the branches it deploys to."
        >
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="repositoryUrl" className="field-label">
                Repository URL
                {form.projectType === 'on_premise' ? (
                  <span className="font-normal text-content-subtle"> (optional with a folder)</span>
                ) : null}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="repositoryUrl"
                  required={form.projectType !== 'on_premise'}
                  value={form.repositoryUrl}
                  onChange={update('repositoryUrl')}
                  className="field-input min-w-0 flex-1 font-mono text-callout"
                  placeholder="https://github.com/organisation/repository.git"
                />
                <button
                  type="button"
                  onClick={readBranches}
                  disabled={reading || submitting || form.repositoryUrl.trim().length === 0}
                  className="btn-secondary h-auto min-h-10 shrink-0 self-stretch"
                >
                  {reading ? <Spinner /> : null}
                  {reading ? 'Reading' : 'Read branches'}
                </button>
              </div>
              {branchError ? (
                <p className="field-error">
                  {branchError} You can still type the branch names below.
                </p>
              ) : null}
              {!branchError && readingCredentialLabel ? (
                <p className="field-hint">
                  Read using the registered credential {readingCredentialLabel}.
                </p>
              ) : null}
              {!branchError && !readingCredentialLabel ? (
                <p className="field-hint">
                  Read the branches so the environments below are picked, not typed. Branch names
                  are case-sensitive.
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
                className="field-input font-mono text-callout"
              />
              <p className="field-hint">The agent branches from this and never commits to it directly.</p>
            </div>

            <EnvironmentEditor
              value={environments}
              onChange={setEnvironments}
              disabled={submitting}
              branches={branches}
            />
          </div>
        </Section>
      ) : null}

      {needsRepository ? (
        <Section
          size="small"
          divided
          title="Access"
          description="How the platform reads the repository and pushes its branches."
        >
          <div className="grid gap-6 sm:grid-cols-2">
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

            {credentials.length > 0 ? (
              <div className="sm:col-span-2">
                <label htmlFor="credentialChoice" className="field-label">
                  Credential
                </label>
                <select
                  id="credentialChoice"
                  value={chosenCredentialId}
                  onChange={(event) => setChosenCredentialId(event.target.value)}
                  className="field-input"
                >
                  <option value="">
                    {defaultCredential
                      ? `Use the default — ${defaultCredential.label}`
                      : 'No default registered'}
                  </option>
                  {credentials.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label} ({entry.credentialKind === 'ssh_key' ? 'SSH key' : 'token'})
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  Registered in Settings, so the same key is not pasted for every project. The
                  connection keeps a reference to it, so rotating it there reaches this project too.
                  {chosenCredential?.hosts.length
                    ? ` Usable for: ${chosenCredential.hosts.join(', ')}.`
                    : ''}
                </p>
              </div>
            ) : null}

            <div className="sm:col-span-2">
              <label htmlFor="credential" className="field-label">
                {usesSshRemote(form.repositoryUrl) ? 'SSH private key' : 'Access token'}{' '}
                <span className="font-normal text-content-subtle">
                  {credentials.length > 0 ? '(leave blank to use the one above)' : '(optional)'}
                </span>
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
                  className="field-input font-mono text-caption"
                  rows={6}
                  spellCheck={false}
                  placeholder={'[REDACTED PRIVATE KEY]'}
                />
              ) : (
                <input
                  id="credential"
                  type="password"
                  value={form.credential}
                  onChange={update('credential')}
                  className="field-input font-mono text-callout"
                  placeholder="Leave blank to add later"
                />
              )}
              <p className="field-hint">
                Encrypted under a key unique to this project and stored by reference. It is never
                returned by the API, written to a log, or sent to an AI provider. It is also used,
                for that one check only, to read branches from a private repository above.
                {credentials.length > 0
                  ? ' Filling this in overrides the credential chosen above, for this project only.'
                  : ''}
              </p>
            </div>
          </div>

          {/*
           * Optional and rarely needed, so it waits behind a disclosure. The
           * fields are controlled by the form state, so closing it keeps what
           * was typed.
           */}
          <Disclosure summary="Linked instance" hint="Optional" className="mt-8">
            <div className="rounded-xl border border-surface-border bg-surface-raised p-4 sm:p-5">
              <p className="text-callout text-content-muted">
                Only needed when this connects to a customer&apos;s existing Odoo.sh or on-premise
                instance: recorded so a restore can later be aimed at that instance&apos;s own
                database manager. This never creates a repository; the code still pulls from the
                repository URL above (ADR-049, ADR-050).
              </p>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="projectUrl" className="field-label">
                    Instance URL
                  </label>
                  <input
                    id="projectUrl"
                    value={form.projectUrl}
                    onChange={update('projectUrl')}
                    className="field-input font-mono text-callout"
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
                    className="field-input font-mono text-callout"
                    placeholder="testpurchase"
                  />
                </div>
                <div className="flex items-end pb-3">
                  <label
                    htmlFor="isOdoosh"
                    className="flex cursor-pointer items-center gap-2 text-callout text-content"
                  >
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
          </Disclosure>
        </Section>
      ) : null}

      {isOdooOnline ? (
        <Section
          size="small"
          divided
          title="Odoo Online instance"
          description="The address and API credentials the agent uses to reach it."
        >
          <div className="mb-6">
            <Alert tone="warning" title="The agent changes this instance directly">
              An Odoo Online project has no repository, no branch and no diff. An approved change is
              made on the live instance, the way Odoo Studio does it, and undoing the task does not
              remove it.
            </Alert>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
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
                className="field-input font-mono text-callout"
                placeholder="https://your-instance.odoo.com"
              />
              <p className="field-hint">
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
                className="field-input font-mono text-callout"
                placeholder="you@example.com"
              />
              <p className="field-hint">The login the API key belongs to, usually an email address.</p>
            </div>

            <div>
              <label htmlFor="odooDb" className="field-label">
                Database <span className="font-normal text-content-subtle">(optional)</span>
              </label>
              <input
                id="odooDb"
                value={odooOnline.db}
                onChange={(event) =>
                  setOdooOnline((previous) => ({ ...previous, db: event.target.value }))
                }
                className="field-input font-mono text-callout"
                placeholder={databaseFromOdooUrl(odooOnline.url) || 'from the URL'}
              />
              <p className="field-hint">
                Defaults to the URL&apos;s subdomain, which is the database name on odoo.com.
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
                className="field-input font-mono text-callout"
                autoComplete="off"
              />
              <p className="field-hint">
                Generated in Odoo under Preferences, Account Security. Encrypted under a key unique
                to this project and stored by reference. It is never returned by the API, written to
                a log, or sent to an AI provider.
              </p>
            </div>
          </div>
        </Section>
      ) : null}

      <FormFooter error={error}>
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? <Spinner /> : null}
          {submitting ? 'Creating' : 'Create project'}
        </button>
      </FormFooter>
    </form>
  );
}

/**
 * The end of a form: any error, then one primary submit with a quiet way out
 * beside it. Stacked on narrow screens so the submit is full width and first.
 */
function FormFooter({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <div className="divider space-y-6 pt-8">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        <Link href="/projects" className="btn-ghost">
          Cancel
        </Link>
        {children}
      </div>
    </div>
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
    <form onSubmit={submit} className="animate-rise-in space-y-10">
      <Section
        size="small"
        title="Project"
        description="These inputs become a structured project specification, held as a versioned record so that project context does not depend on conversation history."
      >
        <div className="grid gap-5 sm:grid-cols-2">
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
      </Section>

      <Section
        size="small"
        divided
        title="What it must do"
        description="The purpose in a sentence or two, then the requirements the agent works from."
      >
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

        <div className="mt-8">
          <span className="field-label">Initial requirements</span>
          <p className="-mt-1 mb-3 text-meta text-content-subtle">
            At least one. A detail line is optional.
          </p>

          {/* Contained: each requirement is a pair of fields that act together. */}
          <ol className="panel divide-y divide-surface-border">
            {requirements.map((requirement, index) => (
              <li key={index} className="p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="font-mono text-caption text-content-subtle">
                    REQ-{String(index + 1).padStart(3, '0')}
                  </span>
                  {requirements.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setRequirements((previous) =>
                          previous.filter((_, position) => position !== index),
                        )
                      }
                      className="btn-ghost btn-sm -my-1 -mr-2"
                      aria-label={`Remove requirement ${index + 1}`}
                    >
                      <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                      Remove
                    </button>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <input
                    value={requirement.title}
                    onChange={(event) => setRequirement(index, 'title', event.target.value)}
                    className="field-input"
                    placeholder="Register equipment against an employee"
                    aria-label={`Requirement ${index + 1}`}
                  />
                  <input
                    value={requirement.detail}
                    onChange={(event) => setRequirement(index, 'detail', event.target.value)}
                    className="field-input text-callout"
                    placeholder="Detail (optional)"
                    aria-label={`Requirement ${index + 1} detail`}
                  />
                </div>
              </li>
            ))}
          </ol>

          <button
            type="button"
            onClick={() => setRequirements((previous) => [...previous, { title: '', detail: '' }])}
            className="btn-secondary btn-sm mt-3"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            Add requirement
          </button>
        </div>
      </Section>

      <Section
        size="small"
        divided
        title="Modules"
        description="What the new instance installs when it is created."
      >
        <fieldset>
          <legend className="sr-only">Modules to install</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceTile
              name="install-mode"
              value="all"
              checked={installMode === 'all'}
              onChange={() => setInstallMode('all')}
              icon={LayoutGrid}
              title="Install everything"
              description="Every module this edition ships, ready to switch on per user. The fast path: the project is cloned from a pre-built database."
            />
            <ChoiceTile
              name="install-mode"
              value="choose"
              checked={installMode === 'choose'}
              onChange={() => setInstallMode('choose')}
              icon={Boxes}
              title="Choose what to install"
              description="Only the apps this project needs. The instance starts small and is built in the background; dependencies are installed automatically."
            />
          </div>
        </fieldset>

        {installMode === 'choose' ? (
          <div className="mt-6 animate-rise-in">
            <ModulePicker
              version={odooVersion}
              edition={odooEdition}
              value={selectedModules}
              onChange={setSelectedModules}
            />
          </div>
        ) : null}
      </Section>

      <Alert tone="info" title="No repository yet">
        A project created this way has no repository, so the agent can analyse and plan but cannot
        commit. Connect a repository from the project settings when one exists.
      </Alert>

      <FormFooter error={error}>
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? <Spinner /> : null}
          {submitting ? 'Creating' : 'Create project and specification'}
        </button>
      </FormFooter>
    </form>
  );
}
