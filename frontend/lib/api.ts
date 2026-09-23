import type {
  AgentCapabilities,
  AgentSession,
  AuditLogEntry,
  AuthTokens,
  CurrentUser,
  EnvironmentKind,
  GitCredential,
  GitCredentialList,
  GitTransport,
  ModelProviderId,
  ModelProviderList,
  ModelProviderRow,
  ModelProviderTestResult,
  OdooVersionRepository,
  PendingAccessRequest,
  PendingApprovalSummary,
  ProjectAccessMember,
  BackupSummary,
  CheckoutStatus,
  CheckoutSyncResult,
  ProjectDetail,
  ProjectDocument,
  ProjectDocumentDetail,
  ProjectGitAccess,
  OdooSettings,
  ProjectEnvironment,
  ProjectPreviewState,
  ProjectSummary,
  PreviewSummary,
  TaskDetail,
  TaskDiff,
  TaskEvent,
  TaskKind,
  TaskSummary,
  UserRegion,
  UserRow,
} from './types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE = `${API_URL}/api/v1`;

const ACCESS_TOKEN_KEY = 'linkederp.accessToken';
const REFRESH_TOKEN_KEY = 'linkederp.refreshToken';

/**
 * Token storage.
 *
 * sessionStorage rather than localStorage: a token that survives the browser
 * being closed is a token an unattended machine still holds. Refresh tokens are
 * single-use server-side, so the cost of losing them on close is one sign-in.
 */
export const tokenStore = {
  get access(): string | null {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
  },
  get refresh(): string | null {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage.getItem(REFRESH_TOKEN_KEY);
  },
  set(tokens: { accessToken: string; refreshToken: string }): void {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
    window.sessionStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
  },
  clear(): void {
    if (typeof window === 'undefined') return;
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    window.sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};

/** An error carrying the API's status and message, for display. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Set for the auth endpoints, which must not attempt a token refresh. */
  skipRefresh?: boolean;
}

/**
 * Single request path for the whole portal.
 *
 * A 401 triggers one refresh attempt and one retry. Concentrating that here
 * means no page has to think about token expiry, and a shared promise prevents a
 * page that fires several requests at once from starting several refreshes -
 * which would fail, because refresh tokens are single-use.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = tokenStore.access;
    if (token) headers.Authorization = `Bearer ${token}`;

    return fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
  };

  let response = await send();

  if (response.status === 401 && !options.skipRefresh && tokenStore.refresh) {
    refreshInFlight = refreshInFlight ?? attemptRefresh();
    const refreshed = await refreshInFlight;
    refreshInFlight = null;
    if (refreshed) response = await send();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text.length > 0 ? safeParse(text) : null;

  if (!response.ok) {
    const message =
      (payload as { message?: string } | null)?.message ??
      `The request failed with status ${response.status}.`;
    throw new ApiError(
      response.status,
      message,
      (payload as { correlationId?: string } | null)?.correlationId,
    );
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Uploads one file as multipart/form-data and parses the JSON response.
 *
 * Separate from `request` because a FormData body must not carry a JSON
 * Content-Type, and the browser sets the multipart boundary itself. The token
 * and refresh handling mirror `request`.
 */
async function uploadRequest<T>(path: string, file: File): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    const token = tokenStore.access;
    if (token) headers.Authorization = `Bearer ${token}`;

    const form = new FormData();
    form.append('file', file, file.name);

    return fetch(`${BASE}${path}`, {
      method: 'POST',
      headers,
      body: form,
      cache: 'no-store',
    });
  };

  let response = await send();

  if (response.status === 401 && tokenStore.refresh) {
    refreshInFlight = refreshInFlight ?? attemptRefresh();
    const refreshed = await refreshInFlight;
    refreshInFlight = null;
    if (refreshed) response = await send();
  }

  const text = await response.text();
  const payload = text.length > 0 ? safeParse(text) : null;

  if (!response.ok) {
    const message =
      (payload as { message?: string } | null)?.message ??
      `The upload failed with status ${response.status}.`;
    throw new ApiError(
      response.status,
      message,
      (payload as { correlationId?: string } | null)?.correlationId,
    );
  }

  return payload as T;
}

async function attemptRefresh(): Promise<boolean> {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken) return false;

  try {
    const response = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      tokenStore.clear();
      return false;
    }
    const tokens = (await response.json()) as AuthTokens;
    tokenStore.set(tokens);
    return true;
  } catch {
    tokenStore.clear();
    return false;
  }
}

/**
 * The API surface, grouped by resource. Every call the portal makes appears
 * here, so the set of endpoints the front end depends on is enumerable.
 */
export const api = {
  auth: {
    register: (body: {
      email: string;
      password: string;
      name: string;
      region: string;
    }) => request<AuthTokens>('/auth/register', { method: 'POST', body, skipRefresh: true }),

    login: (body: { email: string; password: string }) =>
      request<AuthTokens>('/auth/login', { method: 'POST', body, skipRefresh: true }),

    logout: (refreshToken: string | null) =>
      request<void>('/auth/logout', {
        method: 'POST',
        body: refreshToken ? { refreshToken } : {},
      }),

    /** Change your own password. Every other session is revoked on success. */
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      request<{ changed: true }>('/auth/change-password', { method: 'POST', body }),
  },

  users: {
    me: () => request<CurrentUser>('/users/me'),
    list: () => request<UserRow[]>('/users'),
    create: (body: {
      email: string;
      password: string;
      name: string;
      region: UserRegion;
      isAdmin?: boolean;
    }) => request<UserRow>('/users', { method: 'POST', body }),
    update: (
      userId: string,
      body: { region?: UserRegion; isAdmin?: boolean; isActive?: boolean; name?: string },
    ) => request<UserRow>(`/users/${userId}`, { method: 'PATCH', body }),
    remove: (userId: string) => request<{ deleted: true }>(`/users/${userId}`, { method: 'DELETE' }),

    /** Admin sets another account's password; handed over out of band. */
    resetPassword: (userId: string, newPassword: string) =>
      request<{ reset: true }>(`/users/${userId}/reset-password`, {
        method: 'POST',
        body: { newPassword },
      }),
  },

  settings: {
    modelProviders: () => request<ModelProviderList>('/settings/model-providers'),

    /** Where this deployment's Odoo estate lives (ADR-033, ADR-044). */
    odooSettings: () => request<OdooSettings>('/settings/odoo-settings'),
    updateOdooSettings: (body: {
      basePath: string;
      enterprisePath: string;
      projectsRoot: string;
    }) => request<OdooSettings>('/settings/odoo-settings', { method: 'PUT', body }),

    /**
     * The per-version Odoo source catalog (ADR-045). A project created with a
     * cataloged version is generated against that version's own checkout, and
     * its provisioned database is duplicated from the full-installation
     * template built for that version.
     */
    odooVersions: () => request<OdooVersionRepository[]>('/settings/odoo-versions'),

    /**
     * ADR-056: the module picker's catalogue for one version/edition, read
     * live from the host's manifests. `edition` defaults server-side to
     * enterprise when omitted; passed explicitly here so a picker refetch on
     * an edition change always names what it wants.
     */
    odooVersionModules: (version: string, edition: string) =>
      request<{
        version: string;
        edition: string;
        modules: {
          technicalName: string;
          name: string;
          category: string | null;
          isApplication: boolean;
          depends: string[];
        }[];
      }>(`/settings/odoo-versions/${encodeURIComponent(version)}/modules?edition=${encodeURIComponent(edition)}`),

    addOdooVersion: (body: {
      version: string;
      basePath: string;
      enterprisePath?: string;
      description?: string;
    }) => request<OdooVersionRepository>('/settings/odoo-versions', { method: 'POST', body }),

    updateOdooVersion: (
      rowId: string,
      body: {
        basePath?: string;
        enterprisePath?: string;
        description?: string;
        isActive?: boolean;
      },
    ) => request<OdooVersionRepository>(`/settings/odoo-versions/${rowId}`, {
      method: 'PATCH',
      body,
    }),

    removeOdooVersion: (rowId: string) =>
      request<void>(`/settings/odoo-versions/${rowId}`, { method: 'DELETE' }),

    /**
     * Adds a provider. `apiKey` is write-only: no endpoint returns it, and there
     * is no response field it could arrive in.
     */
    addModelProvider: (body: {
      label?: string;
      providerId: ModelProviderId;
      model?: string;
      baseUrl?: string;
      apiKey?: string;
      structuredOutputs?: boolean;
      enabled?: boolean;
    }) => request<ModelProviderRow>('/settings/model-providers', { method: 'POST', body }),

    /** Omit `apiKey` to keep the stored key; send an empty string to remove it. */
    updateModelProvider: (
      rowId: string,
      body: {
        label?: string;
        enabled?: boolean;
        providerId?: ModelProviderId;
        model?: string;
        baseUrl?: string;
        apiKey?: string;
        structuredOutputs?: boolean | null;
      },
    ) => request<ModelProviderRow>(`/settings/model-providers/${rowId}`, {
      method: 'PATCH',
      body,
    }),

    removeModelProvider: (rowId: string) =>
      request<void>(`/settings/model-providers/${rowId}`, { method: 'DELETE' }),

    /**
     * PATCH rather than PUT: the API's CORS configuration never allowed PUT, and
     * this call is cross-origin with an Authorization header, so the preflight
     * would block it before it was sent - which presents as reorder doing nothing.
     */
    reorderModelProviders: (order: string[]) =>
      request<ModelProviderList>('/settings/model-providers/order', {
        method: 'PATCH',
        body: { order },
      }),

    testModelProviderRow: (rowId: string) =>
      request<ModelProviderTestResult>(`/settings/model-providers/${rowId}/test`, {
        method: 'POST',
      }),

    testModelProviderChain: () =>
      request<ModelProviderTestResult[]>('/settings/model-providers/test', {
        method: 'POST',
      }),

    /**
     * What models an endpoint serves. Goes through the server because the browser
     * has no key and must not be given one.
     */
    discoverModels: (body: { baseUrl: string; apiKey?: string }) =>
      request<{ models: string[] }>('/settings/model-providers/discover-models', {
        method: 'POST',
        body,
      }),

    /**
     * Git credentials registered once for the whole deployment (ADR-058).
     *
     * Readable by any signed-in account because the project-creation form has to
     * offer the choice; every write is admin-only server-side, so a 403 here
     * means the viewer's role rather than a client bug. No response carries the
     * value — the shape has nowhere to put one.
     */
    gitCredentials: () => request<GitCredentialList>('/settings/git-credentials'),

    addGitCredential: (body: {
      label: string;
      value: string;
      credentialKind?: 'token' | 'ssh_key';
      hosts?: string[];
      isDefault?: boolean;
      note?: string;
    }) => request<GitCredential>('/settings/git-credentials', { method: 'POST', body }),

    updateGitCredential: (
      id: string,
      body: {
        label?: string;
        /** Omitted keeps the stored value: it can never be read back. */
        value?: string;
        credentialKind?: 'token' | 'ssh_key';
        hosts?: string[];
        isDefault?: boolean;
        enabled?: boolean;
        note?: string;
      },
    ) => request<GitCredential>(`/settings/git-credentials/${id}`, { method: 'PATCH', body }),

    removeGitCredential: (id: string) =>
      request<void>(`/settings/git-credentials/${id}`, { method: 'DELETE' }),

    /**
     * Proves a registered credential against a repository and records the
     * outcome. Returns `ok: false` with the reason rather than throwing, because
     * "this key cannot reach that repository" is something the form renders.
     */
    testGitCredential: (id: string, body: { repositoryUrl: string }) =>
      request<{ ok: boolean; branches: string[]; error: string | null }>(
        `/settings/git-credentials/${id}/test`,
        { method: 'POST', body },
      ),

    auditLogs: (limit = 50) => request<AuditLogEntry[]>(`/settings/audit-logs?limit=${limit}`),
  },

  projects: {
    list: (includeArchived = false) =>
      request<ProjectSummary[]>(
        `/projects${includeArchived ? '?includeArchived=true' : ''}`,
      ),

    get: (projectId: string) => request<ProjectDetail>(`/projects/${projectId}`),

    /**
     * Reveals the Odoo master password for a provisioned instance (ADR-040).
     * admin/owner only, enforced by the API - a 403 from this call means the
     * viewer's role, not a client bug.
     */
    revealMasterPassword: (projectId: string) =>
      request<{ masterPassword: string }>(`/projects/${projectId}/provisioning-secret`),

    create: (body: {
      region: string;
      name: string;
      description?: string;
      projectType: string;
      odooVersion?: string;
      odooEdition?: string;
      defaultBranch?: string;
      repositoryUrl?: string;
      environmentConfig?: Record<string, unknown>;
      environments?: { name: string; branch: string; kind: EnvironmentKind }[];
      /**
       * ADR-050/ADR-054: the customer's own odoo.sh/on-premise instance this
       * connect points at, so a restore can later reach its database manager.
       * Distinct from `repositoryUrl`, which is the git remote the platform
       * pulls from.
       */
      projectUrl?: string;
      projectDatabase?: string;
      isOdoosh?: boolean;
    }) => request<ProjectDetail>('/projects', { method: 'POST', body }),

    createWithAi: (body: {
      region: string;
      name: string;
      odooVersion: string;
      odooEdition?: string;
      description: string;
      requirements: { title: string; detail?: string }[];
      modules?: string[];
    }) => request<ProjectDetail>('/projects/ai', { method: 'POST', body }),

    /** The branches a repository advertises, before the project exists. */
    remoteBranchesFor: (body: {
      repositoryUrl: string;
      /**
       * Optional. A private repository cannot be probed without one, and there is
       * no connection yet to hold a credential (ADR-021). Used for this single
       * `ls-remote` and not stored.
       */
      credential?: string;
      credentialKind?: 'token' | 'ssh_key';
      sshHostKey?: string;
      /** A registered credential to resolve server-side (ADR-058). */
      credentialId?: string;
    }) =>
      request<{ branches: string[]; credentialLabel: string | null }>(
        '/projects/remote-branches',
        { method: 'POST', body },
      ),

    /** The folders an on-premise project may be pointed at. */
    onPremiseLocations: () =>
      request<{
        root: string | null;
        folders: { name: string; path: string; isGitRepository: boolean }[];
      }>('/projects/on-premise-locations'),

    remoteBranches: (projectId: string) =>
      request<{ branches: string[] }>(`/projects/${projectId}/remote-branches`),

    /**
     * Brings the project's provisioned instance up to date with its repository
     * (ADR-049): the platform runs the project's own branch onto the server,
     * the way odoo.sh deploys a build.
     */
    pull: (projectId: string) =>
      request<{
        ok: boolean;
        commit: string | null;
        branch: string | null;
        message: string;
        durationMs: number;
      }>(`/projects/${projectId}/pull`, { method: 'POST' }),

    /**
     * Promotes the project's `staging` branch onto `main` (ADR-057 §1): the
     * reviewed state becomes the promoted state. On a conflict `staging` wins
     * (`-X theirs`), so this always produces a commit rather than stopping for
     * a human there is nobody to ask.
     */
    mergeToMain: (projectId: string) =>
      request<{
        ok: boolean;
        commit: string | null;
        sourceBranch: string | null;
        message: string;
        durationMs: number;
      }>(`/projects/${projectId}/merge-to-main`, { method: 'POST' }),

    /**
     * Brings the instance onto `branch`'s tip *and serves it* (ADR-057 §2):
     * pull, `-u all` against the instance's database, restart the unit. Queued
     * — the request returns once the job is on the queue, and the project's
     * own `restart` block is what a caller polls for the outcome.
     */
    restart: (projectId: string, branch: string) =>
      request<{ queued: boolean; technicalName: string; branch: string }>(
        `/projects/${projectId}/restart`,
        { method: 'POST', body: { branch } },
      ),

    /**
     * The ephemeral preview instance (ADR-052): a short-lived running Odoo built
     * from a task's retained draft, so a reviewer sees the real UI before
     * approving. `preview` reads the live one, `startPreview` builds it,
     * `stopPreview` tears it down early.
     */
    preview: (projectId: string) =>
      request<ProjectPreviewState>(`/projects/${projectId}/preview`),

    startPreview: (projectId: string, taskId: string) =>
      request<{ preview: PreviewSummary | null; message: string }>(
        `/projects/${projectId}/preview`,
        { method: 'POST', body: { taskId } },
      ),

    stopPreview: (projectId: string) =>
      request<{ stopped: boolean; message: string }>(`/projects/${projectId}/preview`, {
        method: 'DELETE',
      }),

    /**
     * The per-client backups (ADR-054): a restorable snapshot of the instance's
     * database, filestore and addons repository. `backups` reads what exists and
     * whether this deployment can take one; `runBackup` takes one on request.
     */
    backups: (projectId: string) =>
      request<{ available: boolean; reason: string | null; backups: BackupSummary[] }>(
        `/projects/${projectId}/backups`,
      ),

    runBackup: (projectId: string) =>
      request<{ backup: BackupSummary | null; message: string }>(
        `/projects/${projectId}/backups`,
        { method: 'POST' },
      ),

    /**
     * What is actually installed in the project's own provisioned instance
     * (ADR-056). Read fresh on every call — no cache — so a list fetched right
     * after an install is not stale.
     */
    installedModules: (projectId: string) =>
      request<{
        available: boolean;
        reason: string | null;
        modules: { name: string; state: string }[];
      }>(`/projects/${projectId}/installed-modules`),

    /**
     * The local clone this host keeps for a project (ADR-063). The GET reads
     * disk only, so `behind` is as of the last sync and the page says so; `sync`
     * is the call that reaches the remote.
     */
    checkoutStatus: (projectId: string) =>
      request<CheckoutStatus>(`/projects/${projectId}/checkout`),

    syncCheckout: (projectId: string, branch: string | null) =>
      request<CheckoutSyncResult>(`/projects/${projectId}/checkout/sync`, {
        method: 'POST',
        body: { branch },
      }),

    analyzeCheckout: (projectId: string, branch: string | null) =>
      request<{ branch: string | null; modules: number | null; message: string }>(
        `/projects/${projectId}/checkout/analyze`,
        { method: 'POST', body: { branch } },
      ),

    update: (projectId: string, body: Record<string, unknown>) =>
      request<ProjectDetail>(`/projects/${projectId}`, { method: 'PATCH', body }),

    /**
     * A project's git transport and credential choice (ADR-059). Read on demand
     * rather than off the project detail: it is consulted rarely, and only the
     * settings page cares.
     */
    gitAccess: (projectId: string) =>
      request<ProjectGitAccess>(`/projects/${projectId}/git-access`),

    /**
     * Sets the transport and the credential. Sending `gitCredentialId: null`
     * clears the project's own choice so it falls back to the deployment default
     * again — that is a different intent from leaving the field out, which keeps
     * whatever is stored.
     */
    updateGitAccess: (
      projectId: string,
      body: { gitTransport?: GitTransport; gitCredentialId?: string | null; gitUsername?: string | null },
    ) =>
      request<ProjectGitAccess>(`/projects/${projectId}/git-access`, {
        method: 'PATCH',
        body,
      }),

    updateAgentPermissions: (projectId: string, permissions: Record<string, boolean>) =>
      request<Record<string, boolean>>(`/projects/${projectId}/agent-permissions`, {
        method: 'PATCH',
        body: { permissions },
      }),

    createConnection: (
      projectId: string,
      body: {
        connectionType: string;
        credential?: string;
        /**
         * What the credential is (ADR-021). A token for HTTPS; an SSH private
         * key for an `ssh://` or `git@host:path` remote. Omitted, the server
         * infers it from the repository URL — but sending it explicitly keeps
         * the two from disagreeing when both are known here.
         */
        credentialKind?: 'token' | 'ssh_key';
        sshHostKey?: string;
        /**
         * A credential registered in deployment settings (ADR-058) to attach
         * instead of supplying `credential` again. The server stores that
         * credential's existing secret reference, so rotating it reaches this
         * project without editing it.
         */
        credentialId?: string;
        metadata?: Record<string, unknown>;
      },
    ) => request<ProjectConnectionResponse>(`/projects/${projectId}/connections`, {
      method: 'POST',
      body,
    }),

    deleteConnection: (projectId: string, connectionId: string) =>
      request<void>(`/projects/${projectId}/connections/${connectionId}`, { method: 'DELETE' }),

    environments: (projectId: string) =>
      request<ProjectEnvironment[]>(`/projects/${projectId}/environments`),

    addEnvironment: (
      projectId: string,
      body: { name: string; branch: string; kind: EnvironmentKind },
    ) => request<ProjectEnvironment>(`/projects/${projectId}/environments`, {
      method: 'POST',
      body,
    }),

    setDefaultEnvironment: (projectId: string, environmentId: string) =>
      request<ProjectEnvironment[]>(
        `/projects/${projectId}/environments/${environmentId}/default`,
        { method: 'PATCH' },
      ),

    /**
     * Archives a project. Reversible, and what "remove it from my list" usually
     * means. The response says which of the two happened, so the caller does not
     * have to infer it from the verb.
     */
    archive: (projectId: string) =>
      request<{ archived: boolean; message: string }>(`/projects/${projectId}`, {
        method: 'DELETE',
      }),

    restore: (projectId: string) =>
      request<ProjectDetail>(`/projects/${projectId}/restore`, { method: 'POST' }),

    /**
     * Deletes a project and everything it owns, permanently. `confirmName` must be
     * the project's exact name; the server refuses anything else.
     */
    destroy: (projectId: string, confirmName: string) =>
      request<{
        deleted: boolean;
        projectName: string;
        tasksDeleted: number;
        secretsDestroyed: number;
        workspacesDiscarded: number;
      }>(`/projects/${projectId}/permanent`, { method: 'DELETE', body: { confirmName } }),
  },

  /** Per-project access: who may open a project, and requests to (ADR-043). */
  access: {
    members: (projectId: string) =>
      request<ProjectAccessMember[]>(`/projects/${projectId}/members`),

    grant: (projectId: string, userId: string) =>
      request<{ granted: boolean }>(`/projects/${projectId}/members`, {
        method: 'POST',
        body: { userId },
      }),

    revoke: (projectId: string, userId: string) =>
      request<void>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

    requestAccess: (projectId: string, reason?: string) =>
      request<{ id: string }>(`/projects/${projectId}/access-requests`, {
        method: 'POST',
        body: { reason },
      }),

    pendingRequests: () => request<PendingAccessRequest[]>('/access-requests'),

    decide: (
      projectId: string,
      requestId: string,
      decision: 'approved' | 'rejected',
      note?: string,
    ) =>
      request<{ decision: string }>(`/projects/${projectId}/access-requests/${requestId}`, {
        method: 'PATCH',
        body: { decision, note },
      }),
  },

  tasks: {
    listForProject: (projectId: string) =>
      request<TaskSummary[]>(`/projects/${projectId}/tasks`),

    /**
     * The requests of one conversation, oldest first (ADR-046). This is what
     * the workspace renders as a thread when a session is opened.
     */
    listForSession: (projectId: string, sessionId: string) =>
      request<TaskSummary[]>(
        `/projects/${projectId}/tasks?sessionId=${encodeURIComponent(sessionId)}`,
      ),

    create: (
      projectId: string,
      body: {
        prompt: string;
        sessionId?: string;
        environmentId?: string;
        kind?: TaskKind;
        documentIds?: string[];
      },
    ) =>
      request<{ task_id: string; id: string; status: string; sessionId: string }>(
        `/projects/${projectId}/tasks`,
        { method: 'POST', body },
      ),

    get: (taskId: string) => request<TaskDetail>(`/tasks/${taskId}`),

    /**
     * The unified diff. On its own call rather than in the task detail, because a
     * patch can be a quarter of a megabyte and the detail is re-fetched on every
     * realtime event.
     */
    diff: (taskId: string) => request<TaskDiff>(`/tasks/${taskId}/diff`),

    events: (taskId: string) =>
      request<
        {
          id: string;
          sequence: number;
          eventType: string;
          status: string;
          message: string;
          payload: Record<string, unknown> | null;
          createdAt: string;
        }[]
      >(`/tasks/${taskId}/events`),

    cancel: (taskId: string, reason?: string) =>
      request<{ id: string; status: string }>(`/tasks/${taskId}/cancel`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),

    sessions: (projectId: string) =>
      request<AgentSession[]>(`/projects/${projectId}/sessions`),
  },

  documents: {
    list: (projectId: string) =>
      request<ProjectDocument[]>(`/projects/${projectId}/documents`),

    read: (projectId: string, documentId: string) =>
      request<ProjectDocumentDetail>(`/projects/${projectId}/documents/${documentId}`),

    upload: (projectId: string, file: File) =>
      uploadRequest<ProjectDocument>(`/projects/${projectId}/documents`, file),

    remove: (projectId: string, documentId: string) =>
      request<{ id: string }>(`/projects/${projectId}/documents/${documentId}`, {
        method: 'DELETE',
      }),
  },

  approvals: {
    pending: () => request<PendingApprovalSummary[]>('/approvals'),

    decide: (taskId: string, decision: 'approved' | 'rejected', note?: string) =>
      request<{ id: string; action: string; status: string }>(`/tasks/${taskId}/approve`, {
        method: 'POST',
        body: note ? { decision, note } : { decision },
      }),
  },

  agent: {
    capabilities: () => request<AgentCapabilities>('/agent/capabilities'),
  },

  health: {
    ready: () =>
      request<{ status: string; checks: Record<string, string> }>('/health/ready', {
        skipRefresh: true,
      }),
  },
};

interface ProjectConnectionResponse {
  id: string;
  connectionType: string;
  status: string;
  metadata: Record<string, unknown>;
  hasCredentials: boolean;
  createdAt: string;
}

/** WebSocket URL for the task event stream, with the access token attached. */
export function taskEventSocketUrl(): string | null {
  const token = tokenStore.access;
  if (!token) return null;
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';
  return `${wsUrl}?token=${encodeURIComponent(token)}`;
}

export type { TaskEvent };
