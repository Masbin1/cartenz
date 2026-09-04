'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import type {
  ModelProviderId,
  ModelProviderList,
  ModelProviderPreset,
  ModelProviderRow,
  ModelProviderTestResult,
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
 */
export default function OrganizationSettingsPage() {
  const { loading, user, organization } = useRequireAuth();
  const organizationId = organization?.organizationId ?? null;

  const [list, setList] = useState<ModelProviderList | null>(null);
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

  const canEdit = organization?.role === 'owner' || organization?.role === 'admin';

  const load = useCallback(async () => {
    if (!organizationId) return;
    try {
      setList(await api.organizations.modelProviders(organizationId));
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The configuration could not be loaded.',
      );
    }
  }, [organizationId]);

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
    if (!organizationId || !form.baseUrl.trim()) return;
    setLoadingModels(true);
    setError(null);
    try {
      const { models } = await api.organizations.discoverModels(organizationId, {
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
    if (!organizationId) return;
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
        await api.organizations.addModelProvider(organizationId, {
          ...base,
          structuredOutputs: form.structuredOutputs ?? undefined,
        });
      } else {
        await api.organizations.updateModelProvider(organizationId, formId, {
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
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.organizations.removeModelProvider(organizationId, row.id);
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
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.organizations.updateModelProvider(organizationId, row.id, {
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
    if (!organizationId || !list) return;
    const rows = [...list.rows];
    const index = rows.findIndex((entry) => entry.id === row.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= rows.length) return;

    [rows[index], rows[target]] = [rows[target], rows[index]];

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setList(
        await api.organizations.reorderModelProviders(
          organizationId,
          rows.map((entry) => entry.id),
        ),
      );
      setNotice('The order was saved.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The order could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const testRow = async (row: ModelProviderRow) => {
    if (!organizationId) return;
    setTestingRowId(row.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.organizations.testModelProviderRow(organizationId, row.id);
      setTestResults((current) => ({ ...current, [row.id]: result }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The test could not be run.');
    } finally {
      setTestingRowId(null);
    }
  };

  const testChain = async () => {
    if (!organizationId) return;
    setTestingChain(true);
    setError(null);
    setNotice(null);
    try {
      const results = await api.organizations.testModelProviderChain(organizationId);
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

  if (loading || !user || !list) return <PageLoading />;

  const needsKey = form.providerId !== 'mock';
  const needsBaseUrl = form.providerId === 'openai-compatible';
  const editing = formId !== null;

  // One form, two contexts: editing an existing row (rendered inside that row)
  // and adding a new one (rendered below the list). They are mutually exclusive
  // - startEdit clears `adding`, startAdd clears `expandedId` - so the ids below
  // never collide.
  const renderProviderForm = () => (
    <div className="space-y-4 border-t border-surface-border px-3 py-3">
      <div>
        <span className="field-label">Preset</span>
        <select
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
      </div>

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
        <span className="field-label">Provider</span>
        <select
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
            className="field-input font-mono text-xs"
          />
          <p className="mt-1.5 text-2xs text-content-subtle">
            Must be https. The prompt carries repository source code and the key
            travels with it, so plain http is accepted only for localhost.
          </p>
        </div>
      ) : null}

      {needsKey ? (
        <>
          <div>
            <span className="field-label">Model</span>
            {form.discoveredModels && form.discoveredModels.length > 0 ? (
              <>
                <select
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
                  className="field-input font-mono text-xs"
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
                    value={form.model}
                    onChange={(event) => setForm({ ...form, model: event.target.value })}
                    disabled={busy}
                    placeholder="model name"
                    className="field-input mt-2 font-mono text-xs"
                  />
                ) : null}
              </>
            ) : (
              <input
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
                disabled={busy}
                placeholder={
                  form.providerId === 'anthropic' ? 'claude-sonnet-4-5' : 'model name'
                }
                className="field-input font-mono text-xs"
              />
            )}
            {needsBaseUrl ? (
              <button
                type="button"
                onClick={() => void loadModels()}
                disabled={busy || loadingModels || !form.baseUrl.trim()}
                className="btn-secondary mt-2 px-2.5 py-1 text-xs"
              >
                {loadingModels ? <Spinner /> : null}
                {loadingModels ? 'Loading' : 'Load models'}
              </button>
            ) : null}
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
              className="field-input font-mono text-xs"
            />
            <p className="mt-1.5 text-2xs text-content-subtle">
              Sealed by the secrets provider on arrival. It is never returned by any
              endpoint, never written to the audit trail, and never sent to the
              browser. Leave this blank to keep the stored key.
            </p>
          </div>
        </>
      ) : null}

      <div>
        <span className="field-label">JSON schema</span>
        <select
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
        <p className="mt-1.5 text-2xs text-content-subtle">
          DeepSeek rejects response_format json_schema and accepts only json_object,
          so it must be "no schema" and the SDK checks the shape instead.
        </p>
      </div>

      {editing ? (
        <label className="flex items-center gap-2 text-xs text-content-muted">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            disabled={busy}
          />
          enabled
        </label>
      ) : null}

      <div className="flex items-center gap-2 border-t border-surface-border pt-3">
        <button
          type="button"
          onClick={() => void saveForm()}
          disabled={busy}
          className="btn-primary"
        >
          {busy ? <Spinner /> : null}
          {busy ? 'Saving' : editing ? 'Save' : 'Add provider'}
        </button>
        <button type="button" onClick={closeForm} disabled={busy} className="btn-ghost">
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Organisation settings</h1>
        <p className="mt-1 text-xs text-content-muted">{organization?.organizationName}</p>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">AI providers</h2>
        </div>

        <div className="space-y-3 px-4 py-4">
          <p className="text-xs text-content-muted">
            Tried in order from the top. If one fails, the next is used.
          </p>

          {list.rows.length === 0 ? (
            <p className="text-2xs text-content-subtle">
              With an empty list the server configuration is used:{' '}
              <span className="font-mono">{list.environmentSummary}</span>
            </p>
          ) : null}

          {list.rows.map((row, index) => {
            const result = testResults[row.id];
            const expanded = expandedId === row.id;

            return (
              <div
                key={row.id}
                className="rounded border border-surface-border bg-surface-raised"
              >
                <div className="flex items-start gap-3 px-3 py-2.5">
                  <span className="mt-0.5 w-4 shrink-0 text-2xs text-content-subtle">
                    {row.priority}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {canEdit ? (
                        <button
                          type="button"
                          onClick={() => (expanded ? setExpandedId(null) : startEdit(row))}
                          className="text-xs font-medium text-content hover:text-accent"
                        >
                          {row.label}
                        </button>
                      ) : (
                        <span className="text-xs font-medium">{row.label}</span>
                      )}
                      {!row.enabled ? (
                        <span className="rounded border border-surface-border px-1.5 py-0.5 text-2xs uppercase tracking-wide text-content-subtle">
                          disabled
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-2xs text-content-subtle">
                      {row.providerId}
                      {row.model ? ` · ${row.model}` : ''}
                    </p>
                    <p className="text-2xs text-content-subtle">
                      {row.baseUrl ? `${row.baseUrl} · ` : ''}
                      {row.hasApiKey ? 'key stored' : 'no key stored'}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {canEdit ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void moveRow(row, -1)}
                          disabled={index === 0 || busy}
                          aria-label="Move up"
                          className="btn-ghost px-2 py-1 text-xs"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => void moveRow(row, 1)}
                          disabled={index === list.rows.length - 1 || busy}
                          aria-label="Move down"
                          className="btn-ghost px-2 py-1 text-xs"
                        >
                          ↓
                        </button>
                        <label className="ml-1 flex items-center gap-1 text-2xs text-content-muted">
                          <input
                            type="checkbox"
                            checked={row.enabled}
                            onChange={() => void toggleEnabled(row)}
                            disabled={busy}
                            className="mt-px"
                          />
                          enabled
                        </label>
                        <button
                          type="button"
                          onClick={() => void testRow(row)}
                          disabled={testingRowId === row.id}
                          className="btn-secondary px-2.5 py-1 text-xs"
                        >
                          {testingRowId === row.id ? <Spinner /> : null}
                          {testingRowId === row.id ? 'Testing' : 'Test'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeRow(row)}
                          disabled={busy}
                          className="text-2xs text-content-subtle hover:text-state-failure disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>

                {row.warning ? <Alert tone="warning">{row.warning}</Alert> : null}
                {result ? (
                  <Alert tone={result.ok ? 'success' : 'error'}>
                    {result.ok ? 'Reachable. ' : 'Not reachable. '}
                    {result.message}
                  </Alert>
                ) : null}

                {expanded && canEdit ? renderProviderForm() : null}
              </div>
            );
          })}

          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-surface-border pt-4">
              <button
                type="button"
                onClick={startAdd}
                disabled={busy || adding}
                className="btn-secondary"
              >
                + Add provider
              </button>

              <button
                type="button"
                onClick={() => void testChain()}
                disabled={testingChain || busy}
                className="btn-secondary"
              >
                {testingChain ? <Spinner /> : null}
                {testingChain ? 'Testing' : 'Test the whole chain'}
              </button>
            </div>
          ) : (
            <p className="border-t border-surface-border pt-4 text-2xs text-content-subtle">
              Only an owner or admin can change this. You can see what is configured but not
              alter it.
            </p>
          )}

          {adding && canEdit ? (
            <div className="rounded border border-surface-border bg-surface-raised">
              {renderProviderForm()}
            </div>
          ) : null}

          {detachedResults
            ? detachedResults.map((result, index) => (
                <Alert key={index} tone={result.ok ? 'success' : 'error'}>
                  {result.label ? `${result.label}: ` : ''}
                  {result.ok ? 'Reachable. ' : 'Not reachable. '}
                  {result.message}
                </Alert>
              ))
            : null}
        </div>
      </section>

      <section className="panel mt-5">
        <div className="panel-header">
          <h2 className="panel-title">What the model is and is not given</h2>
        </div>
        <div className="space-y-2 px-4 py-4 text-2xs text-content-muted">
          <p>
            Everything sent to a provider, and everything received, passes the AI data boundary
            first. That is not configurable here or anywhere else.
          </p>
          <p>
            The model is code-aware and data-blind: it reads source, module structure and
            manifests. It is never given a production database, a customer record, a dump, or any
            credential found in the repository — those are removed before the prompt is sent.
          </p>
          <p>
            Its authority is the tool registry. It cannot run a shell, and it is not offered the
            tools that commit, push or execute repository code.
          </p>
        </div>
      </section>
    </AppShell>
  );
}

/** Whether the row being edited has a stored key, for the token placeholder. */
function rowHasKey(rowId: string | null, list: ModelProviderList): boolean {
  if (!rowId) return false;
  return list.rows.some((row) => row.id === rowId && row.hasApiKey);
}
