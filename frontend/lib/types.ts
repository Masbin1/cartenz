/**
 * API types.
 *
 * Mirrors the enumerations the back end declares in backend/src/core/enums.ts
 * and backend/src/agent/task-state.ts. The task state machine and the tool
 * catalogue are additionally fetched at runtime from /agent/capabilities, so the
 * interface renders the server's definitions rather than these constants where
 * the two could drift.
 */

export type ProjectType = 'repository' | 'odoo_sh' | 'on_premise' | 'odoo_online' | 'ai_project';

export type ConnectionType = 'github' | 'gitlab' | 'odoo_api' | 'connector';

export type OrganizationRole = 'owner' | 'admin' | 'developer' | 'viewer';

export type AgentTaskStatus =
  | 'created'
  | 'queued'
  | 'analyzing'
  | 'planning'
  | 'waiting_approval'
  | 'implementing'
  | 'testing'
  | 'committing'
  | 'pushing'
  | 'building'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: AuthUser;
}

export interface OrganizationMembership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: OrganizationRole;
}

export interface CurrentUser extends AuthUser {
  organizations: OrganizationMembership[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  projectType: ProjectType;
  odooVersion: string | null;
  defaultBranch: string;
  repositoryUrl: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  openTaskCount: number;
}

export interface ProjectConnection {
  id: string;
  connectionType: ConnectionType;
  status: 'pending' | 'connected' | 'error' | 'disabled';
  metadata: Record<string, unknown>;
  hasCredentials: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ProjectSpecification {
  project_name: string;
  framework: string;
  odoo_version: string;
  description: string;
  modules: string[];
  requirements: { id: string; title: string; detail?: string }[];
  deployment: { environment: string };
}

export interface ProjectDetail {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  projectType: ProjectType;
  odooVersion: string | null;
  defaultBranch: string;
  repositoryUrl: string | null;
  environmentConfig: Record<string, unknown>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentPermissions: Record<string, boolean>;
  connections: ProjectConnection[];
  specification: ProjectSpecification | null;
  specificationVersion: number | null;
  memory: ProjectMemory | null;
  recentTasks: TaskSummary[];
  viewerRole: OrganizationRole;
}

export interface TaskSummary {
  id: string;
  reference: string;
  prompt: string;
  status: AgentTaskStatus;
  branch: string | null;
  commitHash?: string | null;
  simulated?: boolean;
  createdAt: string;
  startedAt?: string | null;
  completedAt: string | null;
}

export interface PlanStep {
  order: number;
  title: string;
  detail: string;
}

export interface PlannedFileChange {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  reason: string;
}

export interface ImplementationPlan {
  summary: string;
  odooVersion: string | null;
  steps: PlanStep[];
  filesToModify: PlannedFileChange[];
  validation: string[];
  risks: string[];
  generatedBy: string;
}

export interface ModifiedFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  summary: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface TaskTestResults {
  passed: number;
  failed: number;
  skipped: number;
  suites: { name: string; status: 'passed' | 'failed'; detail?: string }[];
  simulated: boolean;
}

export interface AgentAction {
  id: string;
  sequence: number;
  actionType: 'reasoning' | 'tool' | 'transition' | 'approval';
  toolName: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'denied';
  output: Record<string, unknown> | null;
  denialReason: string | null;
  simulated: boolean;
  durationMs: number | null;
  createdAt: string;
}

export interface Approval {
  id: string;
  taskId: string;
  action: string;
  status: ApprovalStatus;
  context: Record<string, unknown>;
  requiredReason: string;
  decisionNote: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  patchTruncated: boolean;
}

export interface TaskDiff {
  reference: string;
  branch: string | null;
  baseCommit: string | null;
  commitHash: string | null;
  stats: DiffStats | null;
  files: ModifiedFile[];
  patch: string | null;
  available: boolean;
}

/** What the AI data boundary removed, by rule. Never the material itself. */
export interface BoundaryFinding {
  kind: 'secret' | 'pii' | 'structured_data' | 'blocked';
  rule: string;
  occurrences: number;
}

/**
 * A record of one model call (ADR-020).
 *
 * Carries no prompt and no response - those are customer source code. What it
 * carries is who was called, what it cost, and what the boundary removed.
 */
export interface ModelCall {
  operation: 'planning' | 'implementation';
  providerId: string;
  model: string;
  /** False for the scripted provider: no network call was made. */
  calledExternalService: boolean;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  steps: number;
  toolCalls: number;
  boundaryFindings: BoundaryFinding[];
  redactionCount: number;
  boundaryRefused: boolean;
  haltReason: string | null;
  createdAt: string;
}

export interface TaskDetail extends TaskSummary {
  projectId: string;
  sessionId: string | null;
  plan: ImplementationPlan | null;
  modifiedFiles: ModifiedFile[];
  /** The commit the AI branch was created from, for the diff base. */
  baseCommit: string | null;
  /**
   * The environment this task ran against (ADR-021). Null for tasks created
   * before environments existed.
   */
  environment: { id: string; name: string; branch: string; kind: EnvironmentKind } | null;
  diffStats: DiffStats | null;
  /** The patch itself is fetched separately, from /tasks/{id}/diff. */
  hasDiff: boolean;
  /**
   * The capability categories whose results were fabricated, e.g.
   * ["push", "validation"]. Shown in place of a single boolean, which could not
   * distinguish "nothing happened" from "some of these numbers are not real".
   */
  simulatedCapabilities: string[];
  testResults: TaskTestResults | null;
  failureReason: string | null;
  actions: AgentAction[];
  approvals: Approval[];
  pendingApproval: Approval | null;
  modelCalls: ModelCall[];
}

/** A module found in the repository by the analysis step. */
export interface DetectedModule {
  technicalName: string;
  name: string | null;
  version: string | null;
  series: string | null;
  path: string;
  depends: string[];
  installable: boolean | null;
  isApplication: boolean;
  fileCount: number;
}

/**
 * Persistent project context (chapter 12): what the agent has learned about the
 * project from its own analysis. Technical facts only, never customer data.
 */
export interface ProjectMemory {
  detectedOdooVersion: string | null;
  pythonVersion: string | null;
  modules: DetectedModule[];
  repositoryStructure: {
    addonRoots?: string[];
    totalFiles?: number;
    fileCountByExtension?: Record<string, number>;
    truncated?: boolean;
  };
  notes: string[];
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  title: string | null;
  status: 'active' | 'ended';
  startedAt: string;
  endedAt: string | null;
}

export type TaskEventType =
  | 'task_started'
  | 'agent_activity'
  | 'tool_started'
  | 'tool_completed'
  | 'file_modified'
  | 'approval_required'
  | 'test_started'
  | 'test_completed'
  | 'task_completed'
  | 'task_failed'
  | 'task_status_changed';

/** The wire format published by the worker, per chapter 15. */
export interface TaskEvent {
  taskId: string;
  taskReference: string;
  sequence: number;
  type: TaskEventType;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  taskStatus: AgentTaskStatus;
  message: string;
  at: string;
  payload?: Record<string, unknown>;
}

export interface PendingApprovalSummary {
  id: string;
  taskId: string;
  taskReference: string;
  projectId: string;
  projectName: string;
  action: string;
  requiredReason: string;
  context: Record<string, unknown>;
  requestedAt: string;
}

export interface AgentCapabilities {
  tools: {
    name: string;
    description: string;
    permission: string;
    leavesPlatform: boolean;
    simulated: boolean;
  }[];
  taskStatuses: { value: AgentTaskStatus; label: string }[];
  /**
   * Whether this server can push at all (ADR-021). Read from the server rather
   * than assumed, so the portal states the posture of the deployment in front of
   * the person, not the posture the documentation describes.
   */
  git: {
    pushEnabled: boolean;
    pushReason: string;
    sshHostKeyPolicy: string;
  };
}

/** An environment kind. Production is never a target for a task. */
export type EnvironmentKind = 'production' | 'staging' | 'development';

/** A model provider an organisation may configure (ADR-023). */
export type ModelProviderId = 'mock' | 'anthropic' | 'openai-compatible';

/**
 * One configured provider (ADR-023 extended).
 *
 * The key is write-only across this boundary, so `hasApiKey` is all that is said
 * about it - there is no field here it could occupy, which is what makes that
 * guarantee structural rather than a habit.
 */
export interface ModelProviderRow {
  id: string;
  priority: number;
  label: string;
  enabled: boolean;
  providerId: ModelProviderId;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  /** Null follows the server default. False for DeepSeek, which rejects json_schema. */
  structuredOutputs: boolean | null;
  /** Set when the row is accepted but likely to fail, e.g. a keyless local gateway. */
  warning: string | null;
  updatedAt: string | null;
}

/** An organisation's configured providers, or the environment it falls back to. */
export interface ModelProviderList {
  rows: ModelProviderRow[];
  /** True when the list is empty and the server's own configuration is in use. */
  fromEnvironment: boolean;
  /** What that configuration is, for display. Null when rows are configured. */
  environmentSummary: string | null;
}

/**
 * A ready-made configuration offered in the portal.
 *
 * A preset fills the form; it is not a provider kind, and each one stores as an
 * existing `ModelProviderId`. What it is worth naming for is the two fields
 * nobody can guess: the base URL, and whether the endpoint enforces a schema
 * itself.
 */
export interface ModelProviderPreset {
  id: string;
  label: string;
  providerId: ModelProviderId;
  baseUrl: string;
  model: string;
  structuredOutputs: boolean;
  detail: string;
}

export interface ModelProviderTestResult {
  ok: boolean;
  /** Null when the environment fallback was tested rather than a stored row. */
  rowId: string | null;
  priority: number;
  label: string;
  providerId: ModelProviderId;
  model: string;
  calledExternalService: boolean;
  message: string;
  durationMs: number;
}

/**
 * A target environment (ADR-021). On Odoo.sh an environment is a branch, so this
 * is the mapping from a name a person uses to the branch the platform clones.
 */
export interface ProjectEnvironment {
  id: string;
  name: string;
  branch: string;
  kind: EnvironmentKind;
  isDefaultTarget?: boolean;
}

export interface AuditLogEntry {
  id: string;
  eventType: string;
  organizationId: string | null;
  projectId: string | null;
  userId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
