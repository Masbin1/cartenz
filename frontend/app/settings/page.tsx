'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import type {
  ModelProviderId,
  ModelProviderSettings,
  ModelProviderTestResult,
} from '@/lib/types';

const PROVIDERS: {
  id: ModelProviderId;
  label: string;
  detail: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  modelPlaceholder: string;
}[] = [
  {
    id: 'mock',
    label: 'No model (scripted)',
    detail:
      'Nothing is called and no key is held. Plans come from a template, and every plan says so. Useful for exercising the workflow without spending anything.',
    needsKey: false,
    needsBaseUrl: false,
    modelPlaceholder: '',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    detail: 'Claude models, called directly.',
    needsKey: true,
    needsBaseUrl: false,
    modelPlaceholder: 'claude-sonnet-4-5',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    detail:
      'Any endpoint speaking the OpenAI wire format: OpenAI, DeepSeek, Groq, OpenRouter, a local gateway, or a model you host yourself.',
    needsKey: true,
    needsBaseUrl: true,
    modelPlaceholder: 'deepseek-chat',
  },
];

/**
 * Where the AI provider and its API token are configured (ADR-023).
 *
 * One screen, because "which AI is doing this, and with whose key" is one
 * question. The key is entered here and never comes back: the server has no
 * endpoint that returns it, so this page can only report whether one is stored.
 */
export default function OrganizationSettingsPage() {
  const { loading, user, organization } = useRequireAuth();
  const organizationId = organization?.organizationId ?? null;

  const [settings, setSettings] = useState<ModelProviderSettings | null>(null);
  const [providerId, setProviderId] = useState<ModelProviderId>('mock');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ModelProviderTestResult | null>(null);

  const canEdit = organization?.role === 'owner' || organization?.role === 'admin';
  const selected = PROVIDERS.find((entry) => entry.id === providerId) ?? PROVIDERS[0];

  const apply = useCallback((next: ModelProviderSettings) => {
    setSettings(next);
    setProviderId(next.providerId);
    setModel(next.model ?? '');
    setBaseUrl(next.baseUrl ?? '');
    // Never populated from the server, because the server never sends it. An
    // empty field with "a key is stored" beside it is the honest rendering.
    setApiKey('');
  }, []);

  const load = useCallback(async () => {
    if (!organizationId) return;
    try {
      apply(await api.organizations.modelProvider(organizationId));
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The configuration could not be loaded.',
      );
    }
  }, [organizationId, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Saves the form. Returns false if the server refused it.
   *
   * Shared by Save and Test, because testing what is on screen is what a person
   * means by "test this". The previous version tested only what was already
   * stored, so typing a key and pressing Test silently tested the old
   * configuration - or, with nothing saved, reported success for the mock
   * provider.
   */
  const persist = async (): Promise<boolean> => {
    if (!organizationId) return false;

    try {
      apply(
        await api.organizations.setModelProvider(organizationId, {
          providerId,
          model: model.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          // Omitted when blank, so saving a model-name change keeps the stored key
          // rather than clearing it.
          apiKey: apiKey.length > 0 ? apiKey : undefined,
        }),
      );
      return true;
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The configuration could not be saved.',
      );
      return false;
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);

    if (await persist()) setNotice('The model provider was saved.');
    setSaving(false);
  };

  const test = async () => {
    if (!organizationId) return;
    setTesting(true);
    setError(null);
    setNotice(null);
    setTestResult(null);

    try {
      // Saved first, so the test exercises what is on screen. A refused save is
      // reported by persist and there is nothing left to test.
      if (!(await persist())) return;
      setTestResult(await api.organizations.testModelProvider(organizationId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The test could not be run.');
    } finally {
      setTesting(false);
    }
  };

  const clear = async () => {
    if (!organizationId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);

    try {
      apply(await api.organizations.clearModelProvider(organizationId));
      setNotice('The stored key was removed and the server default restored.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The configuration could not be cleared.');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user || !settings) return <PageLoading />;

  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Organisation settings</h1>
        <p className="mt-1 text-xs text-content-muted">
          {organization?.organizationName}
        </p>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">AI provider</h2>
        </div>

        <div className="space-y-5 px-4 py-5">
          <div className="rounded border border-surface-border bg-surface-raised px-3 py-2.5">
            <p className="text-xs">
              {settings.callsExternalService
                ? `Currently ${settings.providerId}${settings.model ? ` / ${settings.model}` : ''}`
                : 'Currently no model is called'}
              {settings.fromEnvironment ? ' — from the server configuration' : ''}
            </p>
            <p className="mt-1 text-2xs text-content-subtle">
              {settings.hasApiKey
                ? 'An API key is stored. It cannot be displayed: the server has no endpoint that returns it.'
                : 'No API key is stored.'}
            </p>
          </div>

          <div>
            <span className="field-label">Provider</span>
            <div className="mt-2 space-y-2">
              {PROVIDERS.map((entry) => (
                <label
                  key={entry.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded border border-surface-border px-3 py-2.5 hover:border-accent/50"
                >
                  <input
                    type="radio"
                    name="providerId"
                    value={entry.id}
                    checked={providerId === entry.id}
                    onChange={() => setProviderId(entry.id)}
                    disabled={!canEdit || saving}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-xs font-medium">{entry.label}</span>
                    <span className="mt-0.5 block text-2xs text-content-subtle">
                      {entry.detail}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {selected.needsBaseUrl ? (
            <div>
              <label htmlFor="baseUrl" className="field-label">
                Base URL
              </label>
              <input
                id="baseUrl"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                disabled={!canEdit || saving}
                placeholder="https://api.openai.com/v1"
                className="field-input font-mono text-xs"
              />
              <p className="mt-1.5 text-2xs text-content-subtle">
                Must be https. The prompt carries repository source code and the key travels
                with it, so plain http is accepted only for localhost.
              </p>
              <table className="mt-2.5 w-full border-collapse text-2xs">
                <tbody className="text-content-subtle">
                  {[
                    ['DeepSeek', 'https://api.deepseek.com', 'deepseek-chat'],
                    ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
                    ['Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
                    ['A local gateway', 'http://127.0.0.1:PORT/v1', 'whichever model it serves'],
                  ].map(([name, url, exampleModel]) => (
                    <tr key={name} className="border-t border-surface-border/60">
                      <td className="py-1 pr-3 align-top text-content">{name}</td>
                      <td className="py-1 pr-3 font-mono align-top">{url}</td>
                      <td className="py-1 font-mono align-top">{exampleModel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {selected.needsKey ? (
            <>
              <div>
                <label htmlFor="model" className="field-label">
                  Model{' '}
                  <span className="text-content-subtle">
                    {selected.id === 'anthropic' ? '(optional)' : '(required)'}
                  </span>
                </label>
                <input
                  id="model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={!canEdit || saving}
                  placeholder={selected.modelPlaceholder}
                  className="field-input font-mono text-xs"
                />
                <p className="mt-1.5 text-2xs text-content-subtle">
                  {selected.id === 'anthropic'
                    ? `Leave blank to use ${selected.modelPlaceholder}.`
                    : 'Required. An OpenAI-compatible endpoint is a wire format rather than a vendor, so there is no model to default to — and sending the wrong name usually comes back looking like a rejected key.'}
                </p>
              </div>

              <div>
                <label htmlFor="apiKey" className="field-label">
                  API token
                </label>
                <input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={!canEdit || saving}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    settings.hasApiKey ? 'A key is stored — type to replace it' : 'Paste the token'
                  }
                  className="field-input font-mono text-xs"
                />
                <p className="mt-1.5 text-2xs text-content-subtle">
                  Sealed by the secrets provider on arrival. It is never returned by any
                  endpoint, never written to the audit trail, and never sent to the browser.
                  {settings.hasApiKey ? ' Leave this blank to keep the stored key.' : ''}
                </p>
              </div>
            </>
          ) : null}

          {testResult ? (
            <Alert tone={testResult.ok ? 'success' : 'error'}>
              {testResult.ok ? 'Reachable. ' : 'Not reachable. '}
              {testResult.message}
            </Alert>
          ) : null}

          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-surface-border pt-4">
              <button type="button" onClick={save} disabled={saving} className="btn-primary">
                {saving ? <Spinner /> : null}
                {saving ? 'Saving' : 'Save'}
              </button>

              <button
                type="button"
                onClick={test}
                disabled={saving || testing}
                className="btn-secondary"
              >
                {testing ? <Spinner /> : null}
                {testing ? 'Testing' : 'Save and test'}
              </button>

              {settings.fromEnvironment ? null : (
                <button
                  type="button"
                  onClick={clear}
                  disabled={saving}
                  className="text-2xs text-content-subtle hover:text-content-muted disabled:opacity-40"
                >
                  Remove and use the server default
                </button>
              )}
            </div>
          ) : (
            <p className="border-t border-surface-border pt-4 text-2xs text-content-subtle">
              Only an owner or admin can change this. You can see what is configured but not
              alter it.
            </p>
          )}
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
