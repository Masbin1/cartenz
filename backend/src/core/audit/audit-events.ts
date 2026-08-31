/**
 * Audit event types. Declared as a closed set so that the audit trail can be
 * queried and reported on: a free-text event name would make the table
 * unqueryable within a release or two.
 */
export const AUDIT_EVENTS = {
  USER_REGISTERED: 'user.registered',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_TOKEN_REFRESHED: 'user.token_refreshed',

  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_MEMBER_ADDED: 'organization.member_added',
  ORGANIZATION_MEMBER_ROLE_CHANGED: 'organization.member_role_changed',
  ORGANIZATION_MEMBER_REMOVED: 'organization.member_removed',

  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_ARCHIVED: 'project.archived',
  PROJECT_RESTORED: 'project.restored',
  /** Permanently deleted, with everything it owned (ADR-024). */
  PROJECT_DELETED: 'project.deleted',
  PROJECT_CONNECTION_CREATED: 'project.connection_created',
  PROJECT_CONNECTION_DELETED: 'project.connection_deleted',
  PROJECT_SPECIFICATION_CREATED: 'project.specification_created',
  PROJECT_AGENT_PERMISSIONS_CHANGED: 'project.agent_permissions_changed',

  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  TASK_TRANSITIONED: 'task.transitioned',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',

  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_GRANTED: 'approval.granted',
  APPROVAL_REJECTED: 'approval.rejected',

  AGENT_ACTION_COMPLETED: 'agent.action_completed',
  AGENT_ACTION_DENIED: 'agent.action_denied',

  ENVIRONMENT_ADDED: 'environment.added',
  ENVIRONMENT_DEFAULT_CHANGED: 'environment.default_changed',
  /** A task named a production environment and was refused (ADR-021 s2). */
  ENVIRONMENT_TARGET_REFUSED: 'environment.target_refused',

  /** The organisation's model provider was configured, cleared or tested (ADR-023). */
  MODEL_PROVIDER_CONFIGURED: 'model_provider.configured',
  MODEL_PROVIDER_CLEARED: 'model_provider.cleared',
  MODEL_PROVIDER_TESTED: 'model_provider.tested',

  AUTHORIZATION_DENIED: 'authorization.denied',
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
