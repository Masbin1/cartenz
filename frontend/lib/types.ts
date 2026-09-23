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

/** How a project's git remote is reached (ADR-059). */
export type GitTransport = 'auto' | 'ssh' | 'https';

export const GIT_TRANSPORTS: readonly GitTransport[] = ['auto', 'ssh', 'https'];

export const GIT_TRANSPORT_LABELS: Record<GitTransport, string> = {
  auto: 'Automatic (from the repository URL)',
  ssh: 'SSH',
  https: 'HTTPS',
};

export type UserRegion = 'indonesia' | 'south_africa' | 'india';

export const USER_REGIONS: readonly UserRegion[] = ['indonesia', 'south_africa', 'india'];

export const USER_REGION_LABELS: Record<UserRegion, string> = {
  indonesia: 'Indonesia',
  south_africa: 'South Africa',
  india: 'India',
};

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

/**
 * How the agent is being asked to work. `change` is the development run the
 * workspace was built for; `chat` is a free-form question whose outcome is a
 * natural-language answer (optionally followed by an approved file write).
 */
export type TaskKind = 'change' | 'chat';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  region: UserRegion;
  isAdmin: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: AuthUser;
}

export interface CurrentUser extends AuthUser {}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  region: UserRegion;
  isAdmin: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  /** Which region this project lives in (ADR-044). */
  region: UserRegion;
  /** Null when the caller cannot open the project (ADR-043). */
  description: string | null;
  projectType: ProjectType;
  odooVersion: string | null;
  defaultBranch: string;
  /** Null when the caller cannot open the project. */
  repositoryUrl: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Null when the caller cannot open the project. */
  taskCount: number | null;
  openTaskCount: number | null;
  /** Whether this caller may open the project at all. */
  hasAccess: boolean;
  /** Their standing request, when they have one worth showing. */
  accessRequestStatus: 'pending' | 'rejected' | null;
}

/** A user as the project access panel sees them (ADR-043, ADR-044). */
export interface ProjectAccessMember {
  userId: string;
  email: string;
  name: string;
  isAdmin: boolean;
  hasAccess: boolean;
  /** Where the access comes from: the admin flag, having created it, or a grant. */
  source: 'admin' | 'creator' | 'grant' | 'none';
  /** Only a grant can be taken away. Admin flag and authorship cannot. */
  revocable: boolean;
}

export interface PendingAccessRequest {
  id: string;
  projectId: string;
  projectName: string;
  userId: string;
  userName: string;
  userEmail: string;
  reason: string | null;
  createdAt: string;
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
  region: UserRegion;
  name: string;
  description: string | null;
  projectType: ProjectType;
  odooVersion: string | null;
  odooEdition: string;
  defaultBranch: string;
  repositoryUrl: string | null;
  environmentConfig: Record<string, unknown>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentPermissions: Record<string, boolean>;
  /** Only on-host models for this project's tasks (ADR-055). */
  localProviderOnly: boolean;
  connections: ProjectConnection[];
  specification: ProjectSpecification | null;
  specificationVersion: number | null;
  memory: ProjectMemory | null;
  recentTasks: TaskSummary[];
  accessReason: 'admin' | 'creator' | 'grant';
  provisioning: ProjectProvisioningInfo;
  restart: ProjectRestartInfo;
  /**
   * The linked instance this project points at (ADR-050, ADR-054), when the
   * operator connected an existing odoo.sh/on-premise project rather than
   * only a repository - so a restore can be aimed at the right instance.
   */
  link: ProjectLink;
}

/**
 * One per-client backup (ADR-054): the database, filestore and addons
 * repository, snapshotted on the host before a staging push or on request.
 * Restorable by an operator without the platform; `path` names where it lives.
 */
export interface BackupSummary {
  id: string;
  status: 'running' | 'completed' | 'failed';
  reason: 'pre_push' | 'manual';
  backupId: string | null;
  path: string | null;
  sizeBytes: number | null;
  error: string | null;
  taskId: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * A provisioned Odoo instance's own connection details (ADR-039, ADR-040).
 * `hasMasterPassword` tells the portal whether a reveal call would return
 * something - the plaintext password is never part of this shape.
 */
export interface ProjectProvisioningInfo {
  status: 'none' | 'pending' | 'provisioned' | 'failed';
  port: number | null;
  url: string | null;
  databaseName: string | null;
  error: string | null;
  provisionedAt: string | null;
  hasMasterPassword: boolean;
  https: {
    status: 'none' | 'pending' | 'issued' | 'failed';
    error: string | null;
  };
}

/** Per-client restore endpoint metadata (ADR-050, ADR-054). */
export interface ProjectLink {
  projectUrl?: string | null;
  database?: string | null;
  isOdoosh: boolean;
}

/**
 * The last restart attempt through the platform (ADR-057): pull, `-u all`,
 * restart the unit. 'pending' while the worker runs the upgrade; 'failed'
 * means the code was rolled back to what the instance was serving before, and
 * `commit`/`branch` describe whichever of those two states it landed on.
 */
export interface ProjectRestartInfo {
  status: 'none' | 'pending' | 'restarted' | 'failed';
  error: string | null;
  commit: string | null;
  branch: string | null;
  restartedAt: string | null;
}

export interface TaskSummary {
  id: string;
  reference: string;
  /** The conversation this request belongs to (ADR-046). */
  sessionId?: string | null;
  prompt: string;
  status: AgentTaskStatus;
  kind: TaskKind;
  /** Present on a chat task that has answered; used to render the thread. */
  answer?: string | null;
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
  /** For a chat task: the agent's final natural-language reply. */
  answer?: string | null;
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

/**
 * One conversation with the agent (ADR-046).
 *
 * This is what the workspace's history pane lists — not individual requests.
 * The extra fields let a row be read without opening it.
 */
export interface AgentSession {
  id: string;
  title: string | null;
  status: 'active' | 'ended';
  startedAt: string;
  endedAt: string | null;
  /** How many requests this conversation holds. */
  taskCount: number;
  /** When it was last worked on, for ordering and for the relative timestamp. */
  lastActivityAt: string;
  /** The state of its most recent request, or null when it holds none. */
  latestStatus: AgentTaskStatus | null;
  /** The most recent prompt, falling back to the title the session was opened with. */
  latestPrompt: string | null;
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

/** Where an organisation's Odoo estate lives (ADR-033). */
export interface OdooPathStatus {
  path: string | null;
  /** Null when unset; otherwise whether the directory is there on the server. */
  exists: boolean | null;
}

export interface OdooSettings {
  basePath: OdooPathStatus;
  enterprisePath: OdooPathStatus;
  projectsRoot: OdooPathStatus;
  /** True when the deployment's environment configuration is what is in force. */
  fromEnvironment: boolean;
  effectiveSourcePaths: string[];
}

/** One row of the per-version Odoo source catalog (ADR-045). */
export interface OdooVersionRepository {
  id: string;
  version: string;
  basePath: string;
  enterprisePath: string | null;
  isActive: boolean;
  description: string | null;
  basePathExists: boolean;
  enterprisePathExists: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A git credential registered once for the whole deployment (ADR-058).
 *
 * There is no `value` field, and that is deliberate rather than an omission:
 * the key is write-only across the API, so the shape sent to the browser has
 * nowhere to put one. `hasValue` is the only thing said about it.
 */
export interface GitCredential {
  id: string;
  label: string;
  credentialKind: 'token' | 'ssh_key';
  /** Hosts this credential may be presented to. Empty means any host. */
  hosts: string[];
  isDefault: boolean;
  enabled: boolean;
  note: string | null;
  hasValue: boolean;
  /** When this credential was last proved against a repository, if ever. */
  lastVerifiedAt: string | null;
  /** Why the last verification failed. Null after a success. */
    lastVerifyError: string | null;
  createdAt: string;
}

export interface GitCredentialList {
  credentials: GitCredential[];
}

/** A project's git transport and credential choice (ADR-059). */
export interface ProjectGitAccess {
  /** The URL as actually used: the project's own, or the connection's. */
  repositoryUrl: string | null;
  /** How the URL parses, when there is one to parse. Null for none, or an unparseable value. */
  urlTransport: 'ssh' | 'https' | null;
  /** The project's own transport choice. 'auto' defers to `urlTransport`. */
  gitTransport: GitTransport;
  /** What transport a push or clone actually uses, resolving 'auto'. */
  effectiveTransport: 'ssh' | 'https' | null;
  /** The project's own credential choice, when it has made one. */
  gitCredentialId: string | null;
  /** The username to combine with a token credential over HTTPS. */
  gitUsername: string | null;
  /** The credential a push or clone actually uses. */
  effectiveCredentialId: string | null;
  effectiveCredentialLabel: string | null;
  effectiveCredentialKind: 'token' | 'ssh_key' | null;
  /** Where the effective credential came from. */
  effectiveCredentialSource: 'project' | 'connection' | 'deployment_default' | 'none';
  /** True when the credential cannot authenticate the effective transport. */
  transportMismatch: boolean;
  /** The deployment-wide default's label, for the "use the default" option. */
  defaultCredentialLabel: string | null;
  /** Everything selectable, so the form needs no second request. */
  availableCredentials: {
    id: string;
    label: string;
    credentialKind: 'token' | 'ssh_key';
    hosts: string[];
    isDefault: boolean;
    enabled: boolean;
  }[];
  /** Whether the project has a remote at all. */
  hasRepository: boolean;
}

export interface UpdateProjectGitAccessDto {
  gitTransport?: GitTransport;
  gitCredentialId?: string | null;
  gitUsername?: string | null;
}

/** A document attached to a project for the agent to read (ADR-030). */
export interface ProjectDocument {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}

export interface ProjectDocumentDetail extends ProjectDocument {
  textContent: string;
}

export interface AuditLogEntry {
  id: string;
  eventType: string;
  projectId: string | null;
  userId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** The lifecycle of an ephemeral preview instance (ADR-052). */
export type PreviewStatus = 'creating' | 'ready' | 'failed' | 'stopped';

export interface PreviewSummary {
  ref: string;
  status: PreviewStatus;
  url: string | null;
  branch: string;
  error: string | null;
  expiresAt: string;
  ttlRemainingMs: number;
}

export interface ProjectPreviewState {
  available: boolean;
  reason: string | null;
  preview: PreviewSummary | null;
}

/**
 * The local clone this host keeps for a project (ADR-063).
 *
 * `behind` is deliberately nullable: it is read from the local
 * remote-tracking ref, so it is the truth as of the last sync, and a checkout
 * that has never been compared says so rather than claiming to be current.
 */
export interface CheckoutBranchState {
  branch: string;
  path: string;
  exists: boolean;
  commit: string | null;
  remoteCommit: string | null;
  behind: number | null;
  dirty: boolean;
  historyDepth: number | null;
  lastSyncedAt: string | null;
}

export interface CheckoutStatus {
  enabled: boolean;
  reason: string | null;
  root: string | null;
  branches: CheckoutBranchState[];
}

export interface CheckoutSyncResult {
  branch: string;
  outcome: 'cloned' | 'up_to_date' | 'fast_forwarded' | 'refused' | 'failed';
  commit: string | null;
  behind: number | null;
  historyDepth: number | null;
  modules: number | null;
  message: string;
  durationMs: number;
}
