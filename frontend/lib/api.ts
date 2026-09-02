import type {
  AgentCapabilities,
  AgentSession,
  AuditLogEntry,
  AuthTokens,
  CurrentUser,
  EnvironmentKind,
  ModelProviderId,
  ModelProviderSettings,
  ModelProviderTestResult,
  PendingApprovalSummary,
  ProjectDetail,
  ProjectEnvironment,
  ProjectSummary,
  TaskDetail,
  TaskDiff,
  TaskEvent,
  TaskSummary,
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
      organizationName?: string;
    }) => request<AuthTokens>('/auth/register', { method: 'POST', body, skipRefresh: true }),

    login: (body: { email: string; password: string }) =>
      request<AuthTokens>('/auth/login', { method: 'POST', body, skipRefresh: true }),

    logout: (refreshToken: string | null) =>
      request<void>('/auth/logout', {
        method: 'POST',
        body: refreshToken ? { refreshToken } : {},
      }),
  },

  users: {
    me: () => request<CurrentUser>('/users/me'),
  },

  organizations: {
    list: () => request<{ id: string; name: string; slug: string; role: string }[]>(
      '/organizations',
    ),
    create: (body: { name: string }) =>
      request<{ id: string; name: string; slug: string }>('/organizations', {
        method: 'POST',
        body,
      }),
    members: (organizationId: string) =>
      request<
        { userId: string; email: string; name: string; role: string; joinedAt: string }[]
      >(`/organizations/${organizationId}/members`),
    auditLogs: (organizationId: string, limit = 50) =>
      request<AuditLogEntry[]>(
        `/organizations/${organizationId}/audit-logs?limit=${limit}`,
      ),

    modelProvider: (organizationId: string) =>
      request<ModelProviderSettings>(`/organizations/${organizationId}/model-provider`),

    /**
     * Saves the provider. `apiKey` is write-only: omit it to keep the stored key,
     * send an empty string to remove it. No endpoint returns it.
     */
    setModelProvider: (
      organizationId: string,
      body: {
        providerId: ModelProviderId;
        model?: string;
        baseUrl?: string;
        apiKey?: string;
      },
    ) => request<ModelProviderSettings>(`/organizations/${organizationId}/model-provider`, {
      method: 'PUT',
      body,
    }),

    clearModelProvider: (organizationId: string) =>
      request<ModelProviderSettings>(`/organizations/${organizationId}/model-provider`, {
        method: 'DELETE',
      }),

    testModelProvider: (organizationId: string) =>
      request<ModelProviderTestResult>(
        `/organizations/${organizationId}/model-provider/test`,
        { method: 'POST' },
      ),
  },

  projects: {
    list: (organizationId: string, includeArchived = false) =>
      request<ProjectSummary[]>(
        `/projects?organizationId=${organizationId}` +
          (includeArchived ? '&includeArchived=true' : ''),
      ),

    get: (projectId: string) => request<ProjectDetail>(`/projects/${projectId}`),

    create: (body: {
      organizationId: string;
      name: string;
      description?: string;
      projectType: string;
      odooVersion?: string;
      defaultBranch?: string;
      repositoryUrl?: string;
      environmentConfig?: Record<string, unknown>;
      environments?: { name: string; branch: string; kind: EnvironmentKind }[];
    }) => request<ProjectDetail>('/projects', { method: 'POST', body }),

    createWithAi: (body: {
      organizationId: string;
      name: string;
      odooVersion: string;
      description: string;
      requirements: { title: string; detail?: string }[];
      modules?: string[];
    }) => request<ProjectDetail>('/projects/ai', { method: 'POST', body }),

    /** The branches a repository advertises, before the project exists. */
    remoteBranchesFor: (body: { organizationId: string; repositoryUrl: string }) =>
      request<{ branches: string[] }>('/projects/remote-branches', { method: 'POST', body }),

    /** The folders an on-premise project may be pointed at. */
    onPremiseLocations: (organizationId: string) =>
      request<{
        root: string | null;
        folders: { name: string; path: string; isGitRepository: boolean }[];
      }>(`/projects/on-premise-locations?organizationId=${organizationId}`),

    remoteBranches: (projectId: string) =>
      request<{ branches: string[] }>(`/projects/${projectId}/remote-branches`),

    update: (projectId: string, body: Record<string, unknown>) =>
      request<ProjectDetail>(`/projects/${projectId}`, { method: 'PATCH', body }),

    updateAgentPermissions: (projectId: string, permissions: Record<string, boolean>) =>
      request<Record<string, boolean>>(`/projects/${projectId}/agent-permissions`, {
        method: 'PATCH',
        body: { permissions },
      }),

    createConnection: (
      projectId: string,
      body: { connectionType: string; credential?: string; metadata?: Record<string, unknown> },
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

  tasks: {
    listForProject: (projectId: string) =>
      request<TaskSummary[]>(`/projects/${projectId}/tasks`),

    create: (
      projectId: string,
      body: { prompt: string; sessionId?: string; environmentId?: string },
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

  approvals: {
    pending: (organizationId: string) =>
      request<PendingApprovalSummary[]>(`/approvals?organizationId=${organizationId}`),

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
