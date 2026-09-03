/**
 * Controlled enumerations for the platform.
 *
 * Every enumerated value used by the domain is declared here and nowhere else.
 * Table 4 of the Technical Architecture is the source; divergences are recorded
 * in ADRs and annotated below.
 *
 * Task status is deliberately NOT declared here. It lives in
 * src/agent/task-state.ts together with its transition table, so that a status
 * cannot be introduced without also declaring how a task reaches it.
 */

/**
 * Project type. Table 4 defines odoo_sh, on_premise and odoo_online; ADR-017
 * adds `repository` for standard Git repositories and `ai_project` for projects
 * specified through the AI flow before any repository exists.
 */
export const PROJECT_TYPES = [
  'repository',
  'odoo_sh',
  'on_premise',
  'odoo_online',
  'ai_project',
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** Project types that require a repository reference before a task may run. */
export const REPOSITORY_BACKED_PROJECT_TYPES: readonly ProjectType[] = ['repository', 'odoo_sh'];

/** Connection type. Table 4, unchanged. */
/**
 * Connection type. Table 4 defines github, gitlab, odoo_api and connector; ADR-021
 * adds odoo_sh, because an Odoo.sh project reached over its native git remote is
 * neither a GitHub nor a GitLab connection and needs an SSH key rather than a token.
 */
export const CONNECTION_TYPES = ['github', 'gitlab', 'odoo_sh', 'odoo_api', 'connector'] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/** Connection health. Not enumerated in Table 4; kept minimal and closed. */
export const CONNECTION_STATUSES = ['pending', 'connected', 'error', 'disabled'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Approval status. Table 4, unchanged. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The action a pending approval authorises. Chapter 11 names production push,
 * production deployment, database migration, production service restart and
 * file deletion as approval-bearing; `implementation_plan` is added because the
 * product workflow requires the plan itself to be approved before any change.
 */
export const APPROVAL_ACTIONS = [
  'implementation_plan',
  'git_push',
  'deployment',
  'database_migration',
  'service_restart',
  'file_deletion',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** Organisation roles. Table 5 of the Technical Architecture. */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Role precedence, ascending. Used by the authorisation service to answer
 * "is this member at least X" without a chain of comparisons at each call site.
 */
export const ROLE_RANK: Readonly<Record<OrganizationRole, number>> = {
  viewer: 0,
  developer: 1,
  admin: 2,
  owner: 3,
};

/** Agent session lifecycle. */
export const AGENT_SESSION_STATUSES = ['active', 'ended'] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/**
 * Classification of a recorded agent action. `reasoning` covers agent narration,
 * `tool` covers a mediated tool execution, `transition` covers a task state
 * change, and `approval` covers an approval request or decision.
 */
export const AGENT_ACTION_TYPES = ['reasoning', 'tool', 'transition', 'approval'] as const;
export type AgentActionType = (typeof AGENT_ACTION_TYPES)[number];

/** Outcome of a recorded agent action. */
export const AGENT_ACTION_STATUSES = ['running', 'succeeded', 'failed', 'denied'] as const;
export type AgentActionStatus = (typeof AGENT_ACTION_STATUSES)[number];

/** Odoo versions the platform will accept on a project. */
export const ODOO_VERSIONS = ['15.0', '16.0', '17.0', '18.0', '19.0'] as const;
export type OdooVersion = (typeof ODOO_VERSIONS)[number];

/**
 * Target environment kinds (ADR-021).
 *
 * In Odoo.sh an environment is a branch: production, one or more staging branches,
 * and development branches. The kind is what the platform reasons about, because
 * `production` is refused as a task target and the other two are not.
 */
export const ENVIRONMENT_KINDS = ['production', 'staging', 'development'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/** Kinds a task may target. Production is absent deliberately. */
export const TARGETABLE_ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  'staging',
  'development',
];

/**
 * What a stored credential is.
 *
 * A fact about the record rather than something inferred from the remote URL: an
 * Odoo.sh project is reached over SSH with a key, a GitHub project over HTTPS with
 * a token, and guessing from the URL would be one more thing to get wrong.
 */
export const CREDENTIAL_KINDS = ['token', 'ssh_key'] as const;

/**
 * The model providers an organisation may configure (ADR-023).
 *
 * `openai-compatible` is one entry rather than several because that is what it
 * is: any endpoint speaking the OpenAI wire format, which covers OpenAI itself,
 * Groq, OpenRouter, Together and a self-hosted vLLM equally. Naming each vendor
 * would imply the platform knows something about them that it does not.
 */
export const MODEL_PROVIDER_IDS = ['mock', 'anthropic', 'openai-compatible'] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

/** Providers that call out and therefore need an API key. Mock needs none. */
export const MODEL_PROVIDERS_REQUIRING_KEY: readonly ModelProviderId[] = [
  'anthropic',
  'openai-compatible',
];
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * Ready-made configurations, offered in the portal (ADR-023 extended).
 *
 * Presets fill a form; they are not provider kinds, and every one of them stores
 * as an existing MODEL_PROVIDER_ID. The value of naming them is the two fields
 * nobody can guess: which base URL an endpoint uses, and whether it enforces a
 * JSON schema itself.
 *
 * 9router and Hermes share one entry because on the deployment this was written
 * for they are the same process, serving http://127.0.0.1:20128/v1 (ADR-023).
 * Two entries with an identical URL would suggest a difference that is not there.
 */
export const MODEL_PROVIDER_PRESETS = [
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
    // DeepSeek rejects response_format json_schema and accepts only json_object.
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
] as const;

/**
 * Hosts that mean "this machine", where plain http carries no network risk and a
 * gateway may legitimately require no key (ADR-023).
 *
 * Defined once and shared, because the transport rule and the credential rule ask
 * the same question and must not answer it differently.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}
