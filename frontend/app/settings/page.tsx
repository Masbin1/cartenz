'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  EyeOff,
  KeyRound,
  Layers,
  Pencil,
  Plus,
  Power,
  PowerOff,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageHeader } from '@/components/ui/page';
import { Section } from '@/components/ui/section';
import { StatusDot } from '@/components/ui/status-dot';
import { ActionMenu } from '@/components/ui/action-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { AccessRequestsPanel } from '@/components/projects/access-requests-panel';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import type {
  GitCredential,
  ModelProviderId,
  ModelProviderList,
  ModelProviderPreset,
  ModelProviderRow,
  ModelProviderTestResult,
  OdooSettings,
  OdooVersionRepository,
} from '@/lib/types';

/**
 * Ready-made configurations, mirrored from `MODEL_PROVIDER_PRESETS` in
 * `backend/src/core/enums.ts`. There is no endpoint that serves them, so the two
 * lists are kept in step by hand; the fields that matter and cannot be guessed
 * are `baseUrl` and `structuredOutputs`, and both are copied exactly.
 */
const PRESETS: ModelProviderPreset[] = [
  {
    id: 'hermes',
    label: 'Hermes (Claude engine)',
    providerId: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:20128/v1',
    model: 'cc/claude-sonnet-5',
    structuredOutputs: true,
    detail:
      'Claude as the agent engine, through the local gateway. Set this as priority 1 and ' +
      'add a second provider below it as the maintenance fallback.',
  },
  {
    id: 'local-gateway',
    label: 'Local gateway (9router / Hermes)',
    providerId: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:20128/v1',
    model: '',
    structuredOutputs: true,
    detail: 'A gateway on this machine. Load its model list rather than guessing a name.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    providerId: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    structuredOutputs: false,
    detail: 'Enforces JSON objects rather than schemas, so schema checking falls to the SDK.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    providerId: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    structuredOutputs: true,
    detail: 'OpenAI directly.',
  },
  {
    id: 'groq',
    label: 'Groq',
    providerId: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    structuredOutputs: true,
    detail: 'Open-weight models, served fast.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic direct',
    providerId: 'anthropic',
    baseUrl: '',
    model: 'claude-sonnet-4-5',
    structuredOutputs: true,
    detail: 'Claude models, called directly rather than through a gateway.',
  },
];

const PROVIDERS: { id: ModelProviderId; label: string }[] = [
  { id: 'mock', label: 'No model (scripted)' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint' },
];

/** What the add/edit form holds. `apiKey` starts empty and is never populated back. */
interface FormState {
  label: string;
  providerId: ModelProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
  structuredOutputs: boolean | null;
  enabled: boolean;
  discoveredModels: string[] | null;
  customModel: boolean;
}

function emptyForm(): FormState {
  return {
    label: '',
    providerId: 'mock',
    model: '',
    baseUrl: '',
    apiKey: '',
    structuredOutputs: null,
    enabled: true,
    discoveredModels: null,
    customModel: false,
  };
}

function formFromRow(row: ModelProviderRow): FormState {
  return {
    label: row.label,
    providerId: row.providerId,
    model: row.model ?? '',
    baseUrl: row.baseUrl ?? '',
    apiKey: '',
    structuredOutputs: row.structuredOutputs,
    enabled: row.enabled,
    discoveredModels: null,
    customModel: false,
  };
}

/**
 * Where the AI providers and their API tokens are configured (ADR-023, extended
 * to an ordered list with failover).
 *
 * One screen, because "which AI is doing this, and with whose key" is one
 * question. A key is entered here and never comes back: the server has no
 * endpoint that returns it, so this page can only report whether one is stored.
 *
 * The page is long and administrative, so it is laid out to be scanned: open
 * sections in one column, an in-page index beside them on wide screens, lists
 * as rows with their status as a dot and their secondary actions in a menu,
 * and add or edit forms in a panel only while they are open.
 */
export default function SettingsPage() {
  const { loading, user } = useRequireAuth();

  const [list, setList] = useState<ModelProviderList | null>(null);
  // The deployment's Odoo estate (ADR-033, ADR-044): the server's view, and the
  // form being edited. Kept apart so the reported existence of each path belongs
  // to what was saved rather than to what is currently typed.
  const [odoo, setOdoo] = useState<OdooSettings | null>(null);
  const [odooForm, setOdooForm] = useState({
    basePath: '',
    enterprisePath: '',
    projectsRoot: '',
  });
  const [savingOdoo, setSavingOdoo] = useState(false);

  // The per-version source catalog (ADR-045): which Odoo checkout serves which
  // series, and the add form for registering one.
  const [versions, setVersions] = useState<OdooVersionRepository[] | null>(null);
  const [addingVersion, setAddingVersion] = useState(false);
  const [versionForm, setVersionForm] = useState({
    version: '19.0',
    basePath: '',
    enterprisePath: '',
    description: '',
  });
  const [versionBusy, setVersionBusy] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [formId, setFormId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [testingRowId, setTestingRowId] = useState<string | null>(null);
  const [testingChain, setTestingChain] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  const [testResults, setTestResults] = useState<Record<string, ModelProviderTestResult>>({});
  const [detachedResults, setDetachedResults] = useState<ModelProviderTestResult[] | null>(null);

  // Git credentials (ADR-058)
  const [gitCredentials, setGitCredentials] = useState<GitCredential[]>([]);
  const [addingCredential, setAddingCredential] = useState(false);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [testingCredentialId, setTestingCredentialId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail: string } | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialForm, setCredentialForm] = useState({
    label: '',
    credentialKind: 'ssh_key' as 'ssh_key' | 'token',
    value: '',
    hosts: '',
    isDefault: false,
    note: '',
  });
  const [testRepoUrl, setTestRepoUrl] = useState('');

  const canEdit = user?.isAdmin ?? false;

  const load = useCallback(async () => {
    try {
      const [providers, odoo, versions, credentials] = await Promise.all([
        api.settings.modelProviders(),
        api.settings.odooSettings(),
        api.settings.odooVersions(),
        api.settings.gitCredentials(),
      ]);
      setList(providers);
      setOdoo(odoo);
      setVersions(versions);
      setGitCredentials(credentials.credentials);
      setOdooForm({
        basePath: odoo.basePath.path ?? '',
        enterprisePath: odoo.enterprisePath.path ?? '',
        projectsRoot: odoo.projectsRoot.path ?? '',
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The configuration could not be loaded.',
      );
    }
  }, []);

  /**
   * Saves the Odoo paths (ADR-033). The server refuses a path that is not there,
   * so a typo is reported here rather than at the first task that needs it.
   */
  const saveOdoo = async () => {
    setSavingOdoo(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.settings.updateOdooSettings(odooForm);
      setOdoo(saved);
      setNotice('The Odoo paths were saved.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The paths could not be saved.');
    } finally {
      setSavingOdoo(false);
    }
  };

  /**
   * Registers a version in the source catalog (ADR-045). The server refuses a
   * path that is not there, and a duplicate version, so both mistakes are
   * reported here rather than at the first project that uses the version.
   */
  const addVersion = async () => {
    setVersionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.addOdooVersion({
        version: versionForm.version,
        basePath: versionForm.basePath.trim(),
        enterprisePath: versionForm.enterprisePath.trim() || undefined,
        description: versionForm.description.trim() || undefined,
      });
      await load();
      setAddingVersion(false);
      setVersionForm({ version: '19.0', basePath: '', enterprisePath: '', description: '' });
      setNotice(`Odoo ${versionForm.version} was registered.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The version could not be saved.');
    } finally {
      setVersionBusy(false);
    }
  };

  const removeVersion = async (row: OdooVersionRepository) => {
    setVersionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.removeOdooVersion(row.id);
      await load();
      setNotice(`Odoo ${row.version} was removed from the catalog.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The version could not be removed.');
    } finally {
      setVersionBusy(false);
    }
  };

  const toggleVersion = async (row: OdooVersionRepository) => {
    setVersionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.updateOdooVersion(row.id, { isActive: !row.isActive });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The version could not be updated.');
    } finally {
      setVersionBusy(false);
    }
  };

  /**
   * Registers a deployment-wide git credential (ADR-058). The value is sealed
   * server-side and never comes back — a save that succeeds shows the label and
   * kind only, which is also what every later read of this list returns.
   */
  const startAddCredential = () => {
    setCredentialId(null);
    setCredentialForm({
      label: '',
      credentialKind: 'ssh_key',
      value: '',
      hosts: '',
      isDefault: gitCredentials.length === 0,
      note: '',
    });
    setAddingCredential(true);
  };

  const startEditCredential = (row: GitCredential) => {
    setCredentialId(row.id);
    setCredentialForm({
      label: row.label,
      credentialKind: row.credentialKind,
      value: '',
      hosts: row.hosts.join(', '),
      isDefault: row.isDefault,
      note: row.note ?? '',
    });
    setAddingCredential(true);
  };

  const closeCredentialForm = () => {
    setAddingCredential(false);
    setCredentialId(null);
  };

  const saveCredential = async () => {
    setCredentialBusy(true);
    setError(null);
    setNotice(null);
    try {
      const hosts = credentialForm.hosts
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      if (credentialId) {
        await api.settings.updateGitCredential(credentialId, {
          label: credentialForm.label.trim(),
          value: credentialForm.value.trim().length > 0 ? credentialForm.value : undefined,
          hosts,
          isDefault: credentialForm.isDefault,
          note: credentialForm.note.trim() || undefined,
        });
        setNotice(`${credentialForm.label} was updated.`);
      } else {
        await api.settings.addGitCredential({
          label: credentialForm.label.trim(),
          credentialKind: credentialForm.credentialKind,
          value: credentialForm.value,
          hosts,
          isDefault: credentialForm.isDefault,
          note: credentialForm.note.trim() || undefined,
        });
        setNotice(`${credentialForm.label} was registered.`);
      }
      await load();
      closeCredentialForm();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The credential could not be saved.');
    } finally {
      setCredentialBusy(false);
    }
  };

  const removeCredential = async (row: GitCredential) => {
    if (!window.confirm(`Remove "${row.label}"? Any connection still using it keeps working, but a rotation will not reach it.`)) {
      return;
    }
    setCredentialBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.removeGitCredential(row.id);
      await load();
      setNotice(`${row.label} was removed.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The credential could not be removed.');
    } finally {
      setCredentialBusy(false);
    }
  };

  const makeDefaultCredential = async (row: GitCredential) => {
    setCredentialBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.updateGitCredential(row.id, { isDefault: true });
      await load();
      setNotice(`${row.label} is now the default.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The default could not be changed.');
    } finally {
      setCredentialBusy(false);
    }
  };

  const toggleCredentialEnabled = async (row: GitCredential) => {
    setCredentialBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.updateGitCredential(row.id, { enabled: !row.enabled });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The credential could not be updated.');
    } finally {
      setCredentialBusy(false);
    }
  };

  /**
   * Proves a registered credential actually reads a repository, rather than
   * trusting that a paste months ago is still good. `testRepoUrl` is not
   * stored — it exists only to give the probe somewhere to reach.
   */
  const testCredential = async (row: GitCredential) => {
    if (!testRepoUrl.trim()) {
      setError('Enter a repository URL to test against first.');
      return;
    }
    setTestingCredentialId(row.id);
    setTestResult(null);
    setError(null);
    try {
      const result = await api.settings.testGitCredential(row.id, { repositoryUrl: testRepoUrl.trim() });
      setTestResult({ id: row.id, ok: true, detail: `Read ${result.branches.length} branches.` });
      await load();
    } catch (caught) {
      setTestResult({
        id: row.id,
        ok: false,
        detail: caught instanceof ApiError ? caught.message : 'The credential could not reach that repository.',
      });
      await load();
    } finally {
      setTestingCredentialId(null);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const closeForm = () => {
    setAdding(false);
    setExpandedId(null);
    setFormId(null);
    setForm(emptyForm());
  };

  const startAdd = () => {
    setFormId(null);
    setForm(emptyForm());
    setAdding(true);
    setExpandedId(null);
  };

  const startEdit = (row: ModelProviderRow) => {
    setFormId(row.id);
    setForm(formFromRow(row));
    setAdding(false);
    setExpandedId(row.id);
  };

  const applyPreset = (preset: ModelProviderPreset) => {
    setForm((current) => ({
      ...current,
      providerId: preset.providerId,
      model: preset.model,
      baseUrl: preset.baseUrl,
      structuredOutputs: preset.structuredOutputs,
      discoveredModels: null,
      customModel: false,
    }));
  };

  const loadModels = async () => {
    if (!form.baseUrl.trim()) return;
    setLoadingModels(true);
    setError(null);
    try {
      const { models } = await api.settings.discoverModels({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.length > 0 ? form.apiKey : undefined,
      });
      setForm((current) => {
        const next: FormState = { ...current, discoveredModels: models };
        if (models.length > 0) {
          if (!current.model || !models.includes(current.model)) {
            next.model = models[0];
            next.customModel = false;
          }
        } else {
          next.customModel = true;
        }
        return next;
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The model list could not be loaded.');
    } finally {
      setLoadingModels(false);
    }
  };

  const saveForm = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);

    const base = {
      label: form.label.trim(),
      providerId: form.providerId,
      model: form.model.trim(),
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.length > 0 ? form.apiKey : undefined,
    };

    try {
      if (formId === null) {
        await api.settings.addModelProvider({
          ...base,
          structuredOutputs: form.structuredOutputs ?? undefined,
        });
      } else {
        await api.settings.updateModelProvider(formId, {
          ...base,
          enabled: form.enabled,
          structuredOutputs: form.structuredOutputs,
        });
      }
      await load();
      closeForm();
      setNotice(formId === null ? 'The provider was added.' : 'The provider was saved.');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The configuration could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async (row: ModelProviderRow) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.removeModelProvider(row.id);
      await load();
      setNotice('The provider was removed.');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The provider could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (row: ModelProviderRow) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.updateModelProvider(row.id, {
        enabled: !row.enabled,
      });
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The provider could not be updated.',
      );
    } finally {
      setBusy(false);
    }
  };

  const moveRow = async (row: ModelProviderRow, direction: -1 | 1) => {
    if (!list) return;
    const rows = [...list.rows];
    const index = rows.findIndex((entry) => entry.id === row.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= rows.length) return;

    [rows[index], rows[target]] = [rows[target], rows[index]];

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setList(await api.settings.reorderModelProviders(rows.map((entry) => entry.id)));
      setNotice('The order was saved.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The order could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const testRow = async (row: ModelProviderRow) => {
    setTestingRowId(row.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.settings.testModelProviderRow(row.id);
      setTestResults((current) => ({ ...current, [row.id]: result }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The test could not be run.');
    } finally {
      setTestingRowId(null);
    }
  };

  const testChain = async () => {
    setTestingChain(true);
    setError(null);
    setNotice(null);
    try {
      const results = await api.settings.testModelProviderChain();
      const byRow: Record<string, ModelProviderTestResult> = {};
      const detached: ModelProviderTestResult[] = [];
      for (const result of results) {
        if (result.rowId) byRow[result.rowId] = result;
        else detached.push(result);
      }
      setTestResults((current) => ({ ...current, ...byRow }));
      setDetachedResults(detached.length > 0 ? detached : null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The test could not be run.');
    } finally {
      setTestingChain(false);
    }
  };

  if (loading || !user) return <PageLoading />;

  const header = (
    <PageHeader
      title="Settings"
      description="Configuration for the whole deployment: the Odoo estate, Git access and the AI that does the work (ADR-044)."
    />
  );

  // The page frame stays while the configuration loads; the sections arrive in
  // place of the skeletons. A failed load says so instead of loading forever.
  if (!list) {
    return (
      <AppShell>
        <div className="page">
          {header}
          {error ? (
            <Alert tone="error">{error}</Alert>
          ) : (
            <div className="space-y-12">
              {[0, 1, 2].map((index) => (
                <div key={index} className="space-y-4">
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-4 w-80 max-w-full" />
                  <SkeletonRows rows={2} className="-mx-4" />
                </div>
              ))}
            </div>
          )}
        </div>
      </AppShell>
    );
  }

  const needsKey = form.providerId !== 'mock';
  const needsBaseUrl = form.providerId === 'openai-compatible';
  const editing = formId !== null;

  /** The in-page index. Access requests are listed only for an administrator, as the section is. */
  const sections: { id: string; label: string }[] = [
    ...(user?.isAdmin ? [{ id: 'access-requests', label: 'Access requests' }] : []),
    { id: 'odoo-source', label: 'Odoo source' },
    { id: 'odoo-versions', label: 'Odoo versions' },
    { id: 'git-credentials', label: 'Git credentials' },
    { id: 'ai-providers', label: 'AI providers' },
    { id: 'model-boundary', label: 'What the model sees' },
  ];

  // One form, two contexts: editing an existing row (rendered inside that row)
  // and adding a new one (rendered below the list). They are mutually exclusive
  // - startEdit clears `adding`, startAdd clears `expandedId` - so the ids below
  // never collide.
  const renderProviderForm = () => (
    <div className="space-y-5">
      <div>
        <label htmlFor="form-preset" className="field-label">
          Preset
        </label>
        <select
          id="form-preset"
          value=""
          onChange={(event) => {
            const preset = PRESETS.find((entry) => entry.id === event.target.value);
            if (preset) applyPreset(preset);
          }}
          className="field-input"
        >
          <option value="" disabled>
            Choose a preset to fill the form…
          </option>
          {PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        <p className="field-hint">Fills in the provider, base URL, model and schema setting.</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="form-label" className="field-label">
            Label
          </label>
          <input
            id="form-label"
            value={form.label}
            onChange={(event) => setForm({ ...form, label: event.target.value })}
            disabled={busy}
            placeholder="9router Paket-Hemat"
            className="field-input"
          />
        </div>

        <div>
          <label htmlFor="form-provider" className="field-label">
            Provider
          </label>
          <select
            id="form-provider"
            value={form.providerId}
            onChange={(event) =>
              setForm({
                ...form,
                providerId: event.target.value as ModelProviderId,
                discoveredModels: null,
                customModel: false,
              })
            }
            disabled={busy}
            className="field-input"
          >
            {PROVIDERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {needsBaseUrl ? (
        <div>
          <label htmlFor="form-baseUrl" className="field-label">
            Base URL
          </label>
          <input
            id="form-baseUrl"
            value={form.baseUrl}
            onChange={(event) =>
              setForm({
                ...form,
                baseUrl: event.target.value,
                discoveredModels: null,
              })
            }
            disabled={busy}
            placeholder="https://api.openai.com/v1"
            className="field-input font-mono text-callout"
          />
          <p className="field-hint">
            Must be https: the prompt carries repository source and the key travels with it. Plain
            http is accepted only for localhost.
          </p>
        </div>
      ) : null}

      {needsKey ? (
        <>
          <div>
            <label htmlFor="form-model" className="field-label">
              Model
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                {form.discoveredModels && form.discoveredModels.length > 0 ? (
                  <>
                    <select
                      id="form-model"
                      value={form.customModel ? '__custom__' : form.model}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === '__custom__') {
                          setForm({ ...form, customModel: true, model: '' });
                        } else {
                          setForm({ ...form, customModel: false, model: value });
                        }
                      }}
                      disabled={busy}
                      className="field-input font-mono text-callout"
                    >
                      {form.discoveredModels.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                      <option value="__custom__">Use a different name…</option>
                    </select>
                    {form.customModel ? (
                      <input
                        aria-label="Model name"
                        value={form.model}
                        onChange={(event) => setForm({ ...form, model: event.target.value })}
                        disabled={busy}
                        placeholder="model name"
                        className="field-input mt-2 font-mono text-callout"
                      />
                    ) : null}
                  </>
                ) : (
                  <input
                    id="form-model"
                    value={form.model}
                    onChange={(event) => setForm({ ...form, model: event.target.value })}
                    disabled={busy}
                    placeholder={
                      form.providerId === 'anthropic' ? 'claude-sonnet-4-5' : 'model name'
                    }
                    className="field-input font-mono text-callout"
                  />
                )}
              </div>
              {needsBaseUrl ? (
                <button
                  type="button"
                  onClick={() => void loadModels()}
                  disabled={busy || loadingModels || !form.baseUrl.trim()}
                  className="btn-secondary shrink-0 sm:h-[46px]"
                >
                  {loadingModels ? <Spinner /> : null}
                  {loadingModels ? 'Loading' : 'Load models'}
                </button>
              ) : null}
            </div>
          </div>

          <div>
            <label htmlFor="form-apiKey" className="field-label">
              API token
            </label>
            <input
              id="form-apiKey"
              type="password"
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                editing && rowHasKey(formId, list)
                  ? 'A key is stored — type to replace it'
                  : 'Paste the token'
              }
              className="field-input font-mono text-callout"
            />
            <p className="field-hint">
              Sealed by the secrets provider on arrival. Never returned by any endpoint, written to
              the audit trail or sent to the browser. Leave blank to keep the stored key.
            </p>
          </div>
        </>
      ) : null}

      <div>
        <label htmlFor="form-schema" className="field-label">
          JSON schema
        </label>
        <select
          id="form-schema"
          value={form.structuredOutputs === null ? '' : String(form.structuredOutputs)}
          onChange={(event) => {
            const value = event.target.value;
            setForm({
              ...form,
              structuredOutputs: value === '' ? null : value === 'true',
            });
          }}
          disabled={busy}
          className="field-input"
        >
          <option value="">Follow the server default</option>
          <option value="true">The endpoint enforces a schema itself</option>
          <option value="false">JSON objects only (no schema)</option>
        </select>
        <p className="field-hint">
          DeepSeek rejects response_format json_schema and accepts only json_object, so choose
          &quot;JSON objects only&quot; for it; the SDK then checks the shape.
        </p>
      </div>

      {editing ? (
        <CheckboxField
          checked={form.enabled}
          onChange={(checked) => setForm({ ...form, enabled: checked })}
          disabled={busy}
          label="Enabled"
          hint="A disabled provider stays in the list but is skipped."
        />
      ) : null}

      <FormActions>
        <button
          type="button"
          onClick={() => void saveForm()}
          disabled={busy}
          className="btn-primary"
        >
          {busy ? <Spinner /> : null}
          {busy ? 'Saving' : editing ? 'Save changes' : 'Add provider'}
        </button>
        <button type="button" onClick={closeForm} disabled={busy} className="btn-ghost">
          Cancel
        </button>
      </FormActions>
    </div>
  );

  return (
    <AppShell>
      <div className="page">
        {header}

        <div className="lg:grid lg:grid-cols-[176px_minmax(0,1fr)] lg:gap-12">
          <SectionIndex items={sections} />

          <div className="min-w-0 space-y-16">
            {error || notice ? (
              <div className="space-y-3">
                {error ? <Alert tone="error">{error}</Alert> : null}
                {notice ? <Alert tone="success">{notice}</Alert> : null}
              </div>
            ) : null}

            {user?.isAdmin ? <AccessRequestsPanel id="access-requests" /> : null}

            {/* ---- Odoo source and projects (ADR-033) ---------------------- */}
            <Section
              id="odoo-source"
              title="Odoo source and projects"
              description="Where this deployment's Odoo lives. The agent reads the base and enterprise checkouts and never writes to them."
              className="scroll-mt-24 lg:scroll-mt-10"
            >
              <div className="space-y-5">
                {odoo?.fromEnvironment ? (
                  <Alert tone="info" title="Using the server's environment configuration">
                    No paths are set here
                    {odoo.effectiveSourcePaths.length > 0 ? (
                      <>
                        , so these are in force:{' '}
                        <span className="break-all font-mono text-meta">
                          {odoo.effectiveSourcePaths.join(', ')}
                        </span>
                      </>
                    ) : (
                      ', and it sets no Odoo source, so the agent has no reference to read'
                    )}
                    .
                  </Alert>
                ) : null}

                <div className="panel">
                  <div className="panel-body space-y-6 pt-5 sm:pt-6">
                    {(
                      [
                        {
                          key: 'basePath' as const,
                          label: 'Odoo base',
                          hint: 'The Odoo checkout, for example /home/user/linkederp/base/odoo. Read-only.',
                          status: odoo?.basePath,
                        },
                        {
                          key: 'enterprisePath' as const,
                          label: 'Enterprise addons',
                          hint: 'The enterprise addons directory. Read-only. Leave blank if you have none.',
                          status: odoo?.enterprisePath,
                        },
                        {
                          key: 'projectsRoot' as const,
                          label: 'Projects root',
                          hint: 'Where new projects are created, for example /home/user/linkederp. Each gets its own addons/ directory, the only place the agent writes.',
                          status: odoo?.projectsRoot,
                        },
                      ]
                    ).map((field) => (
                      <div key={field.key}>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                          <label className="text-callout font-medium text-content" htmlFor={field.key}>
                            {field.label}
                          </label>
                          {field.status?.path ? (
                            <StatusDot tone={field.status.exists ? 'success' : 'failure'} size="small">
                              {field.status.exists ? 'Found on the server' : 'Not found on the server'}
                            </StatusDot>
                          ) : null}
                        </div>
                        <input
                          id={field.key}
                          className="field-input font-mono text-callout"
                          placeholder="/absolute/path"
                          value={odooForm[field.key]}
                          onChange={(event) =>
                            setOdooForm((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                        />
                        <p className="field-hint">{field.hint}</p>
                      </div>
                    ))}

                    <FormActions>
                      <button className="btn-primary" onClick={() => void saveOdoo()} disabled={savingOdoo}>
                        {savingOdoo ? <Spinner /> : null}
                        Save paths
                      </button>
                      <span className="meta">A path that does not exist on the server is refused, not saved.</span>
                    </FormActions>
                  </div>
                </div>
              </div>
            </Section>

            {/* ---- Odoo versions (ADR-045) --------------------------------- */}
            <Section
              id="odoo-versions"
              title="Odoo versions"
              description="One full checkout per version. A project on a listed version is generated against that source, with its database copied from the version's full-installation template."
              className="scroll-mt-24 lg:scroll-mt-10"
              actions={
                canEdit && !addingVersion && (versions ?? []).length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setAddingVersion(true)}
                    disabled={versionBusy}
                    className="btn-secondary btn-sm"
                  >
                    <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    Register version
                  </button>
                ) : null
              }
            >
              <div className="space-y-5">
                {(versions ?? []).length === 0 && !addingVersion ? (
                  <EmptyBox>
                    <EmptyState
                      compact
                      icon={Layers}
                      title="No versions registered"
                      description="Projects fall back to the single Odoo base above."
                      action={
                        canEdit ? (
                          <button
                            type="button"
                            onClick={() => setAddingVersion(true)}
                            disabled={versionBusy}
                            className="btn-secondary"
                          >
                            Register version
                          </button>
                        ) : undefined
                      }
                    />
                  </EmptyBox>
                ) : null}

                {(versions ?? []).length > 0 ? (
                  <ul className="-mx-4 space-y-1">
                    {(versions ?? []).map((row) => (
                      <li key={row.id} className="list-row items-start">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="text-body font-medium text-content">Odoo {row.version}</span>
                            <StatusDot
                              tone={!row.isActive ? 'idle' : row.basePathExists ? 'success' : 'failure'}
                              size="small"
                            >
                              {!row.isActive ? 'Inactive' : row.basePathExists ? 'Active' : 'Checkout missing'}
                            </StatusDot>
                          </div>
                          {row.description ? (
                            <p className="mt-0.5 text-callout text-content-muted">{row.description}</p>
                          ) : null}
                          <p className="mt-1 truncate font-mono text-caption text-content-subtle" title={row.basePath}>
                            {row.basePath}
                            {row.basePathExists ? (
                              ''
                            ) : (
                              <span className="font-sans text-state-failure"> — not found on the server</span>
                            )}
                          </p>
                          {row.enterprisePath ? (
                            <p className="truncate font-mono text-caption text-content-subtle" title={row.enterprisePath}>
                              {row.enterprisePath}
                              {row.enterprisePathExists === false ? (
                                <span className="font-sans text-state-failure"> — not found on the server</span>
                              ) : (
                                ''
                              )}
                            </p>
                          ) : null}
                        </div>

                        {canEdit ? (
                          <ActionMenu
                            label={`Actions for Odoo ${row.version}`}
                            items={[
                              {
                                label: row.isActive ? 'Deactivate' : 'Activate',
                                icon: row.isActive ? PowerOff : Power,
                                onSelect: () => void toggleVersion(row),
                                disabled: versionBusy,
                              },
                              {
                                label: 'Remove from catalogue',
                                icon: Trash2,
                                tone: 'danger',
                                separated: true,
                                onSelect: () => void removeVersion(row),
                                disabled: versionBusy,
                              },
                            ]}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {canEdit && addingVersion ? (
                  <FormPanel title="Register an Odoo version">
                    <div className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <label htmlFor="version-version" className="field-label">
                          Version
                        </label>
                        <select
                          id="version-version"
                          value={versionForm.version}
                          onChange={(event) => setVersionForm({ ...versionForm, version: event.target.value })}
                          disabled={versionBusy}
                          className="field-input"
                        >
                          {['15.0', '16.0', '17.0', '18.0', '19.0'].map((version) => (
                            <option key={version} value={version}>
                              Odoo {version}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="version-description" className="field-label">
                          Note
                        </label>
                        <input
                          id="version-description"
                          value={versionForm.description}
                          onChange={(event) =>
                            setVersionForm({ ...versionForm, description: event.target.value })
                          }
                          disabled={versionBusy}
                          placeholder="Optional — e.g. which licence this enterprise tree carries"
                          className="field-input"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="version-base" className="field-label">
                        Base checkout
                      </label>
                      <input
                        id="version-base"
                        value={versionForm.basePath}
                        onChange={(event) =>
                          setVersionForm({ ...versionForm, basePath: event.target.value })
                        }
                        disabled={versionBusy}
                        placeholder="/opt/odoo/versions/19.0/odoo"
                        className="field-input font-mono text-callout"
                      />
                      <p className="field-hint">The repository root holding odoo-bin. Read-only to the agent.</p>
                    </div>

                    <div>
                      <label htmlFor="version-enterprise" className="field-label">
                        Enterprise addons
                      </label>
                      <input
                        id="version-enterprise"
                        value={versionForm.enterprisePath}
                        onChange={(event) =>
                          setVersionForm({ ...versionForm, enterprisePath: event.target.value })
                        }
                        disabled={versionBusy}
                        placeholder="/opt/odoo/versions/19.0/enterprise"
                        className="field-input font-mono text-callout"
                      />
                      <p className="field-hint">Optional.</p>
                    </div>

                    <FormActions>
                      <button
                        type="button"
                        onClick={() => void addVersion()}
                        disabled={versionBusy || !versionForm.basePath.trim()}
                        className="btn-primary"
                      >
                        {versionBusy ? <Spinner /> : null}
                        {versionBusy ? 'Saving' : 'Register version'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddingVersion(false)}
                        disabled={versionBusy}
                        className="btn-ghost"
                      >
                        Cancel
                      </button>
                    </FormActions>
                  </FormPanel>
                ) : null}
              </div>
            </Section>

            {/* ---- Git credentials (ADR-058) ------------------------------- */}
            <Section
              id="git-credentials"
              title="Git credentials"
              description="An SSH key or access token registered once, so a new project does not need one pasted in. The default is offered first; the others stay available to pick."
              className="scroll-mt-24 lg:scroll-mt-10"
              actions={
                canEdit && !addingCredential && gitCredentials.length > 0 ? (
                  <button type="button" onClick={startAddCredential} className="btn-secondary btn-sm">
                    <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    Register credential
                  </button>
                ) : null
              }
            >
              <div className="space-y-6">
                {gitCredentials.length === 0 && !addingCredential ? (
                  <EmptyBox>
                    <EmptyState
                      compact
                      icon={KeyRound}
                      title="No credentials registered"
                      description="Until one is, every new project asks for a key or token to be pasted in."
                      action={
                        canEdit ? (
                          <button type="button" onClick={startAddCredential} className="btn-secondary">
                            Register credential
                          </button>
                        ) : undefined
                      }
                    />
                  </EmptyBox>
                ) : null}

                {gitCredentials.length > 0 ? (
                  <>
                    <div className="max-w-xl">
                      <label htmlFor="credential-test-url" className="field-label">
                        Test against
                      </label>
                      <input
                        id="credential-test-url"
                        value={testRepoUrl}
                        onChange={(event) => setTestRepoUrl(event.target.value)}
                        placeholder="git@github.com:organisation/repository.git"
                        className="field-input font-mono text-callout"
                      />
                      <p className="field-hint">
                        A repository to prove a credential against with{' '}
                        <code className="code-chip">git ls-remote</code>. Nothing is cloned.
                      </p>
                    </div>

                    <ul className="-mx-4 space-y-1">
                      {gitCredentials.map((row) => {
                        const verification = !row.enabled
                          ? { tone: 'idle' as const, label: 'Disabled' }
                          : row.lastVerifyError
                            ? { tone: 'failure' as const, label: 'Test failed' }
                            : row.lastVerifiedAt
                              ? { tone: 'success' as const, label: 'Verified' }
                              : { tone: 'neutral' as const, label: 'Not tested' };

                        return (
                          <li key={row.id} className="list-row items-start">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                {canEdit ? (
                                  <button
                                    type="button"
                                    onClick={() => startEditCredential(row)}
                                    className="text-left text-body font-medium text-content transition-colors hover:text-accent"
                                  >
                                    {row.label}
                                  </button>
                                ) : (
                                  <span className="text-body font-medium text-content">{row.label}</span>
                                )}
                                <StatusDot tone={verification.tone} size="small">
                                  {verification.label}
                                </StatusDot>
                              </div>
                              <p className="mt-0.5 text-meta text-content-subtle">
                                {row.isDefault ? (
                                  <span className="font-medium text-content-muted">Default · </span>
                                ) : null}
                                {row.credentialKind === 'ssh_key' ? 'SSH key' : 'Access token'}
                                {' · '}
                                {row.hosts.length > 0 ? `Usable for ${row.hosts.join(', ')}` : 'Usable for any host'}
                              </p>
                              {row.note ? (
                                <p className="mt-1 text-callout text-content-muted">{row.note}</p>
                              ) : null}
                              {row.lastVerifiedAt ? (
                                <p
                                  className={`mt-1 text-meta ${
                                    row.lastVerifyError ? 'text-state-failure' : 'text-content-subtle'
                                  }`}
                                >
                                  {row.lastVerifyError
                                    ? `Last test failed: ${row.lastVerifyError}`
                                    : `Last confirmed working ${new Date(row.lastVerifiedAt).toLocaleString()}`}
                                </p>
                              ) : (
                                <p className="mt-1 text-meta text-content-subtle">Never tested.</p>
                              )}
                              {testResult && testResult.id === row.id ? (
                                <p
                                  className={`mt-1 animate-fade-in text-meta font-medium ${
                                    testResult.ok ? 'text-state-success' : 'text-state-failure'
                                  }`}
                                >
                                  {testResult.detail}
                                </p>
                              ) : null}
                            </div>

                            {canEdit ? (
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => void testCredential(row)}
                                  disabled={credentialBusy || testingCredentialId === row.id || !row.enabled}
                                  className="btn-ghost btn-sm"
                                >
                                  {testingCredentialId === row.id ? <Spinner className="h-3.5 w-3.5" /> : null}
                                  {testingCredentialId === row.id ? 'Testing' : 'Test'}
                                </button>
                                <ActionMenu
                                  label={`Actions for ${row.label}`}
                                  items={[
                                    {
                                      label: 'Edit',
                                      icon: Pencil,
                                      onSelect: () => startEditCredential(row),
                                    },
                                    ...(!row.isDefault
                                      ? [
                                          {
                                            label: 'Make default',
                                            icon: Star,
                                            onSelect: () => void makeDefaultCredential(row),
                                            disabled: credentialBusy || !row.enabled,
                                          },
                                        ]
                                      : []),
                                    {
                                      label: row.enabled ? 'Disable' : 'Enable',
                                      icon: row.enabled ? PowerOff : Power,
                                      onSelect: () => void toggleCredentialEnabled(row),
                                      disabled: credentialBusy,
                                    },
                                    {
                                      label: 'Remove',
                                      icon: Trash2,
                                      tone: 'danger',
                                      separated: true,
                                      onSelect: () => void removeCredential(row),
                                      disabled: credentialBusy,
                                    },
                                  ]}
                                />
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null}

                {canEdit && addingCredential ? (
                  <FormPanel
                    title={credentialId ? `Edit ${credentialForm.label || 'credential'}` : 'Register a credential'}
                    description="The value is sealed on save and never returned by any read. To rotate it, save a new one."
                  >
                    <div className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <label htmlFor="credential-label" className="field-label">
                          Label
                        </label>
                        <input
                          id="credential-label"
                          value={credentialForm.label}
                          onChange={(event) =>
                            setCredentialForm({ ...credentialForm, label: event.target.value })
                          }
                          disabled={credentialBusy}
                          placeholder="GitHub - Masbin1"
                          className="field-input"
                        />
                      </div>

                      <div>
                        <label htmlFor="credential-kind" className="field-label">
                          Kind
                        </label>
                        <select
                          id="credential-kind"
                          value={credentialForm.credentialKind}
                          onChange={(event) =>
                            setCredentialForm({
                              ...credentialForm,
                              credentialKind: event.target.value as 'ssh_key' | 'token',
                            })
                          }
                          disabled={credentialBusy || credentialId !== null}
                          className="field-input"
                        >
                          <option value="ssh_key">SSH private key</option>
                          <option value="token">Access token</option>
                        </select>
                        {credentialId !== null ? (
                          <p className="field-hint">
                            The kind of an existing credential cannot change. Register a new one instead.
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div>
                      <label htmlFor="credential-value" className="field-label">
                        {credentialForm.credentialKind === 'ssh_key' ? 'Private key' : 'Access token'}
                      </label>
                      {credentialForm.credentialKind === 'ssh_key' ? (
                        // A private key spans multiple lines; a single-line input drops them
                        // on paste and produces "error in libcrypto" later, on a project.
                        <textarea
                          id="credential-value"
                          value={credentialForm.value}
                          onChange={(event) =>
                            setCredentialForm({ ...credentialForm, value: event.target.value })
                          }
                          disabled={credentialBusy}
                          className="field-input font-mono text-callout"
                          rows={6}
                          spellCheck={false}
                          placeholder={'[REDACTED PRIVATE KEY]'}
                        />
                      ) : (
                        <input
                          id="credential-value"
                          type="password"
                          value={credentialForm.value}
                          onChange={(event) =>
                            setCredentialForm({ ...credentialForm, value: event.target.value })
                          }
                          disabled={credentialBusy}
                          className="field-input font-mono text-callout"
                        />
                      )}
                      <p className="field-hint">
                        {credentialId !== null ? 'Leave blank to keep the current one. ' : ''}
                        A flattened paste (line breaks lost) is repaired before it is sealed. It is
                        never returned or logged.
                      </p>
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <label htmlFor="credential-hosts" className="field-label">
                          Hosts
                        </label>
                        <input
                          id="credential-hosts"
                          value={credentialForm.hosts}
                          onChange={(event) =>
                            setCredentialForm({ ...credentialForm, hosts: event.target.value })
                          }
                          disabled={credentialBusy}
                          placeholder="github.com, gitlab.com"
                          className="field-input font-mono text-callout"
                        />
                        <p className="field-hint">Optional, comma-separated. Empty means any host.</p>
                      </div>

                      <div>
                        <label htmlFor="credential-note" className="field-label">
                          Note
                        </label>
                        <input
                          id="credential-note"
                          value={credentialForm.note}
                          onChange={(event) =>
                            setCredentialForm({ ...credentialForm, note: event.target.value })
                          }
                          disabled={credentialBusy}
                          placeholder="Optional"
                          className="field-input"
                        />
                      </div>
                    </div>

                    <CheckboxField
                      checked={credentialForm.isDefault}
                      onChange={(checked) => setCredentialForm({ ...credentialForm, isDefault: checked })}
                      disabled={credentialBusy}
                      label="Use as the default credential"
                      hint="Offered automatically when a project is created."
                    />

                    <FormActions>
                      <button
                        type="button"
                        onClick={() => void saveCredential()}
                        disabled={
                          credentialBusy ||
                          !credentialForm.label.trim() ||
                          (credentialId === null && !credentialForm.value.trim())
                        }
                        className="btn-primary"
                      >
                        {credentialBusy ? <Spinner /> : null}
                        {credentialBusy ? 'Saving' : credentialId ? 'Save changes' : 'Register credential'}
                      </button>
                      <button
                        type="button"
                        onClick={closeCredentialForm}
                        disabled={credentialBusy}
                        className="btn-ghost"
                      >
                        Cancel
                      </button>
                    </FormActions>
                  </FormPanel>
                ) : null}
              </div>
            </Section>

            {/* ---- AI providers (ADR-023) ---------------------------------- */}
            <Section
              id="ai-providers"
              title="AI providers"
              description="Tried in order from the top. If one fails, the next is used."
              className="scroll-mt-24 lg:scroll-mt-10"
              actions={
                canEdit ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void testChain()}
                      disabled={testingChain || busy}
                      className="btn-ghost btn-sm"
                    >
                      {testingChain ? <Spinner className="h-3.5 w-3.5" /> : null}
                      {testingChain ? 'Testing' : 'Test the chain'}
                    </button>
                    <button
                      type="button"
                      onClick={startAdd}
                      disabled={busy || adding}
                      className="btn-secondary btn-sm"
                    >
                      <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                      Add provider
                    </button>
                  </>
                ) : null
              }
            >
              <div className="space-y-5">
                {list.rows.length === 0 ? (
                  <EmptyBox>
                    <div className="flex flex-col items-center px-6 py-10 text-center">
                      <span
                        className="mb-4 flex h-10 w-10 items-center justify-center rounded-2xl bg-surface-overlay text-content-subtle"
                        aria-hidden="true"
                      >
                        <Sparkles className="h-5 w-5" strokeWidth={1.5} />
                      </span>
                      <p className="text-body font-semibold text-content">Using the server configuration</p>
                      <p className="mt-1.5 max-w-sm text-callout text-content-muted">
                        With an empty list, the server&apos;s own provider is used:
                      </p>
                      <code className="code-chip mt-3 max-w-full break-all">{list.environmentSummary}</code>
                    </div>
                  </EmptyBox>
                ) : null}

                {list.rows.length > 0 ? (
                  <ul className="-mx-4 space-y-1">
                    {list.rows.map((row, index) => {
                      const result = testResults[row.id];
                      const expanded = expandedId === row.id;

                      return (
                        <li
                          key={row.id}
                          className={`rounded-xl transition-colors ${expanded ? 'bg-surface-overlay/40' : ''}`}
                        >
                          <div className="list-row items-start">
                            <span
                              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-caption font-medium text-content-muted"
                              aria-label={`Priority ${row.priority}`}
                            >
                              {row.priority}
                            </span>

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                {canEdit ? (
                                  <button
                                    type="button"
                                    onClick={() => (expanded ? setExpandedId(null) : startEdit(row))}
                                    aria-expanded={expanded}
                                    className="text-left text-body font-medium text-content transition-colors hover:text-accent"
                                  >
                                    {row.label}
                                  </button>
                                ) : (
                                  <span className="text-body font-medium text-content">{row.label}</span>
                                )}
                                <StatusDot tone={row.enabled ? 'success' : 'idle'} size="small">
                                  {row.enabled ? 'Enabled' : 'Disabled'}
                                </StatusDot>
                              </div>
                              <p className="mt-0.5 text-meta text-content-subtle">
                                {row.providerId}
                                {row.model ? (
                                  <>
                                    {' · '}
                                    <span className="font-mono text-caption">{row.model}</span>
                                  </>
                                ) : null}
                                {' · '}
                                {row.hasApiKey ? 'Key stored' : 'No key stored'}
                              </p>
                              {row.baseUrl ? (
                                <p className="mt-0.5 truncate font-mono text-caption text-content-subtle" title={row.baseUrl}>
                                  {row.baseUrl}
                                </p>
                              ) : null}
                            </div>

                            {canEdit ? (
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => void testRow(row)}
                                  disabled={testingRowId === row.id}
                                  className="btn-ghost btn-sm"
                                >
                                  {testingRowId === row.id ? <Spinner className="h-3.5 w-3.5" /> : null}
                                  {testingRowId === row.id ? 'Testing' : 'Test'}
                                </button>
                                <ActionMenu
                                  label={`Actions for ${row.label}`}
                                  items={[
                                    {
                                      label: expanded ? 'Close editor' : 'Edit',
                                      icon: Pencil,
                                      onSelect: () => (expanded ? setExpandedId(null) : startEdit(row)),
                                    },
                                    {
                                      label: 'Move up',
                                      icon: ArrowUp,
                                      onSelect: () => void moveRow(row, -1),
                                      disabled: index === 0 || busy,
                                      separated: true,
                                    },
                                    {
                                      label: 'Move down',
                                      icon: ArrowDown,
                                      onSelect: () => void moveRow(row, 1),
                                      disabled: index === list.rows.length - 1 || busy,
                                    },
                                    {
                                      label: row.enabled ? 'Disable' : 'Enable',
                                      icon: row.enabled ? PowerOff : Power,
                                      onSelect: () => void toggleEnabled(row),
                                      disabled: busy,
                                    },
                                    {
                                      label: 'Remove',
                                      icon: Trash2,
                                      tone: 'danger',
                                      separated: true,
                                      onSelect: () => void removeRow(row),
                                      disabled: busy,
                                    },
                                  ]}
                                />
                              </div>
                            ) : null}
                          </div>

                          {row.warning || result ? (
                            <div className="space-y-2 px-4 pb-3 sm:pl-14">
                              {row.warning ? <Alert tone="warning">{row.warning}</Alert> : null}
                              {result ? (
                                <Alert tone={result.ok ? 'success' : 'error'}>
                                  {result.ok ? 'Reachable. ' : 'Not reachable. '}
                                  {result.message}
                                </Alert>
                              ) : null}
                            </div>
                          ) : null}

                          {expanded && canEdit ? (
                            <div className="px-4 pb-4 sm:pl-14">
                              <div className="panel animate-rise-in">
                                <div className="panel-body pt-5 sm:pt-6">{renderProviderForm()}</div>
                              </div>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}

                {!canEdit ? (
                  <p className="meta">
                    Only an owner or admin can change this. You can see what is configured but not
                    alter it.
                  </p>
                ) : null}

                {adding && canEdit ? (
                  <FormPanel title="Add a provider">{renderProviderForm()}</FormPanel>
                ) : null}

                {detachedResults ? (
                  <div className="space-y-2">
                    {detachedResults.map((result, index) => (
                      <Alert key={index} tone={result.ok ? 'success' : 'error'}>
                        {result.label ? `${result.label}: ` : ''}
                        {result.ok ? 'Reachable. ' : 'Not reachable. '}
                        {result.message}
                      </Alert>
                    ))}
                  </div>
                ) : null}
              </div>
            </Section>

            {/* ---- The AI data boundary ------------------------------------ */}
            <Section
              id="model-boundary"
              title="What the model is and is not given"
              description="Fixed by the platform. None of this can be changed here or anywhere else."
              className="scroll-mt-24 lg:scroll-mt-10"
            >
              <div className="grid gap-8 sm:grid-cols-3 sm:gap-6">
                <BoundaryFact icon={ShieldCheck} title="One data boundary">
                  Everything sent to a provider, and everything received, passes the AI data
                  boundary first.
                </BoundaryFact>
                <BoundaryFact icon={EyeOff} title="Code-aware, data-blind">
                  It reads source, module structure and manifests. It is never given a production
                  database, a customer record, a dump, or any credential found in the repository:
                  those are removed before the prompt is sent.
                </BoundaryFact>
                <BoundaryFact icon={Wrench} title="Limited authority">
                  Its authority is the tool registry. It cannot run a shell, and it is not offered
                  the tools that commit, push or execute repository code.
                </BoundaryFact>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** Whether the row being edited has a stored key, for the token placeholder. */
function rowHasKey(rowId: string | null, list: ModelProviderList): boolean {
  if (!rowId) return false;
  return list.rows.some((row) => row.id === rowId && row.hasApiKey);
}

/**
 * The in-page index for a long administrative page: a quiet sticky column of
 * anchor links, shown on wide screens only. The link for the section nearest
 * the top of the viewport is marked current; it is navigation, not state the
 * page depends on.
 */
function SectionIndex({ items }: { items: { id: string; label: string }[] }) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null);
  const ids = items.map((item) => item.id).join(',');

  useEffect(() => {
    const elements = ids
      .split(',')
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0 || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '0px 0px -65% 0px' },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [ids]);

  return (
    <nav aria-label="On this page" className="hidden lg:block">
      <ul className="sticky top-10 space-y-0.5">
        {items.map((item) => {
          const current = active === item.id;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                onClick={() => setActive(item.id)}
                aria-current={current ? 'location' : undefined}
                className={`block rounded-lg px-3 py-1.5 text-callout transition-colors ${
                  current
                    ? 'bg-surface-raised font-medium text-content ring-1 ring-surface-border'
                    : 'text-content-subtle hover:bg-surface-overlay/70 hover:text-content'
                }`}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A contained add or edit form under a list: a headline, optional context, then fields. */
function FormPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="panel animate-rise-in">
      <div className="panel-header flex-col items-start gap-1">
        <h3 className="text-headline text-content">{title}</h3>
        {description ? <p className="text-callout text-content-muted">{description}</p> : null}
      </div>
      <div className="panel-body space-y-5 pt-3">{children}</div>
    </div>
  );
}

/** The end of a form: the one primary action first, then a quiet cancel or note. */
function FormActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-surface-border pt-5 sm:flex-row sm:items-center">
      {children}
    </div>
  );
}

/** A checkbox with its label and a quiet line saying what it means. */
function CheckboxField({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="mt-1 h-4 w-4 shrink-0"
      />
      <span>
        <span className="block text-callout font-medium text-content">{label}</span>
        {hint ? <span className="block text-meta text-content-subtle">{hint}</span> : null}
      </span>
    </label>
  );
}

/** A quiet dashed outline around an empty state inside a section. */
function EmptyBox({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-dashed border-surface-border">{children}</div>;
}

/** One fact about the AI data boundary: an icon, a short headline, the detail. */
function BoundaryFact({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Icon className="h-5 w-5 text-content-subtle" strokeWidth={1.75} aria-hidden="true" />
      <p className="mt-3 text-headline text-content">{title}</p>
      <p className="mt-1.5 text-callout text-content-muted">{children}</p>
    </div>
  );
}
