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
  /** An admin changed another account's region or admin flag (ADR-044). */
  USER_UPDATED: 'user.updated',
  /** An admin created an account directly rather than through self-registration. */
  USER_CREATED: 'user.created',
  /** An admin deleted an account. */
  USER_DELETED: 'user.deleted',
  /** Somebody changed their own password, having proved the current one. */
  USER_PASSWORD_CHANGED: 'user.password_changed',
  /**
   * An admin set another account's password without knowing the old one. Kept
   * distinct from a self-service change: this is one person taking over another's
   * credential, which is exactly the event an audit reader is looking for.
   */
  USER_PASSWORD_RESET: 'user.password_reset',

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
  /** An admin/owner revealed a provisioned instance's Odoo master password (ADR-040). */
  PROJECT_MASTER_PASSWORD_REVEALED: 'project.master_password_revealed',
  /** A created project was given a repository on GitHub and pushed to it (ADR-041). */
  PROJECT_GITHUB_REPOSITORY_CONNECTED: 'project.github_repository_connected',
  /**
   * ...and it could not be, which is recorded rather than swallowed: the project is
   * real and usable either way, but a person who expected a remote has to know.
   */
  PROJECT_GITHUB_REPOSITORY_FAILED: 'project.github_repository_failed',

  /** A person was given, or had withdrawn, access to a single project (ADR-043). */
  PROJECT_ACCESS_GRANTED: 'project.access_granted',
  PROJECT_ACCESS_REVOKED: 'project.access_revoked',
  /** Somebody asked for access to a project they could not open, and what was decided. */
  PROJECT_ACCESS_REQUESTED: 'project.access_requested',
  PROJECT_ACCESS_DECIDED: 'project.access_decided',

  /** A document was uploaded to a project for the agent to read (ADR-030). */
  PROJECT_DOCUMENT_UPLOADED: 'project.document_uploaded',
  PROJECT_DOCUMENT_DELETED: 'project.document_deleted',

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

  /**
   * A commit was pushed without an approval because the task targeted a
   * development or staging environment (ADR-041). Recorded so that "who authorised
   * this push" has an answer — the configuration did, deliberately, and here it is.
   */
  TASK_PUSH_AUTO_APPROVED: 'task.push_auto_approved',

  /** The organisation's model provider was configured, cleared or tested (ADR-023). */
  MODEL_PROVIDER_CONFIGURED: 'model_provider.configured',
  MODEL_PROVIDER_CLEARED: 'model_provider.cleared',
  MODEL_PROVIDER_TESTED: 'model_provider.tested',
  MODEL_PROVIDER_REORDERED: 'model_provider.reordered',

  /** The organisation's Odoo paths were configured in the portal (ADR-033). */
  ODOO_SETTINGS_UPDATED: 'odoo_settings.updated',

  /** The per-version Odoo source catalog was changed (ADR-045). */
  ODOO_VERSION_REPOSITORY_CREATED: 'odoo_version_repository.created',
  ODOO_VERSION_REPOSITORY_UPDATED: 'odoo_version_repository.updated',
  ODOO_VERSION_REPOSITORY_REMOVED: 'odoo_version_repository.removed',

  AUTHORIZATION_DENIED: 'authorization.denied',
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
