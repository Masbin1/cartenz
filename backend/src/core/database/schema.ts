import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  ENVIRONMENT_KINDS,
  CREDENTIAL_KINDS,
  MODEL_PROVIDER_IDS,
  AGENT_ACTION_STATUSES,
  AGENT_ACTION_TYPES,
  AGENT_SESSION_STATUSES,
  APPROVAL_ACTIONS,
  APPROVAL_STATUSES,
  CONNECTION_STATUSES,
  CONNECTION_TYPES,
  ORGANIZATION_ROLES,
  PROJECT_TYPES,
} from '../enums';
import { AGENT_TASK_STATUSES } from '../../agent/task-state';

/**
 * Persistent schema. Table 3 of the Technical Architecture is the source; the
 * additions are `refresh_tokens` (ADR-015), `secret_records` (ADR-014),
 * `project_specifications` and `agent_task_events`.
 *
 * Two conventions hold throughout:
 *
 *  1. Organisation isolation. Every row that can be reached by a request carries
 *     `organization_id`, either directly or through exactly one hop. Queries
 *     filter on it, and the authorisation service is the only place that decides
 *     which organisation a request may see.
 *
 *  2. No secret material. No column on any table below holds a credential, a
 *     token or a password in plaintext. `project_connections` holds a reference;
 *     `secret_records` holds ciphertext only; `refresh_tokens` holds a hash.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// Drizzle needs a mutable tuple for enum-like text columns.
const asEnum = <T extends readonly string[]>(values: T) =>
  [...values] as unknown as [string, ...string[]];

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    // scrypt output, salt and parameters. Never a plaintext or reversible value.
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    // Case-insensitive uniqueness: sign-in must not depend on how the address
    // was typed, and two accounts must not differ only by case.
    emailUnique: uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`),
  }),
);

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    ...timestamps,
  },
  (table) => ({
    slugUnique: uniqueIndex('organizations_slug_unique').on(table.slug),
  }),
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: asEnum(ORGANIZATION_ROLES) }).notNull(),
    ...timestamps,
  },
  (table) => ({
    membershipUnique: uniqueIndex('organization_members_org_user_unique').on(
      table.organizationId,
      table.userId,
    ),
    byUser: index('organization_members_user_idx').on(table.userId),
  }),
);

/**
 * Refresh tokens (ADR-015). The token itself is never stored: only a SHA-256
 * hash, so that a disclosure of this table does not yield a usable session.
 * Rotation writes `replacedById`, which makes reuse of a spent token
 * detectable.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex('refresh_tokens_hash_unique').on(table.tokenHash),
    byUser: index('refresh_tokens_user_idx').on(table.userId),
  }),
);

/**
 * Ciphertext store (ADR-014). The only table holding encrypted secret material,
 * and therefore the only table a migration to Vault must drain. `dataKeyId`
 * names the per-project key the value is sealed under.
 */
export const secretRecords = pgTable(
  'secret_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    // Stable, human-readable handle used as the reference from other tables.
    ref: text('ref').notNull(),
    dataKeyId: uuid('data_key_id').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    ...timestamps,
  },
  (table) => ({
    refUnique: uniqueIndex('secret_records_ref_unique').on(table.ref),
    byProject: index('secret_records_project_idx').on(table.projectId),
  }),
);

/** Per-project data keys, themselves sealed under the configured root key. */
export const secretDataKeys = pgTable(
  'secret_data_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    wrappedKey: text('wrapped_key').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeUnique: uniqueIndex('secret_data_keys_scope_unique').on(
      table.organizationId,
      table.projectId,
    ),
  }),
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    projectType: text('project_type', { enum: asEnum(PROJECT_TYPES) }).notNull(),
    odooVersion: text('odoo_version'),
    defaultBranch: text('default_branch').notNull().default('main'),
    // Repository URL only. Credentials live behind a connection reference.
    repositoryUrl: text('repository_url'),
    /**
     * Non-sensitive environment configuration: Odoo addon paths, Python
     * version, target build environment. Never credentials.
     */
    environmentConfig: jsonb('environment_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /**
     * Agent permissions per chapter 11. Held per project and independent of
     * user roles. Defaults are applied by the application, not the column, so
     * that the data-blind posture is expressed in one place in code.
     */
    agentPermissions: jsonb('agent_permissions')
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    byOrganization: index('projects_organization_idx').on(table.organizationId),
    nameUniquePerOrg: uniqueIndex('projects_org_name_unique').on(
      table.organizationId,
      table.name,
    ),
  }),
);

/**
 * The model provider an organisation has configured (ADR-023).
 *
 * One row per organisation, so the configuration is one thing a person can look
 * at and change rather than a set of environment variables an operator has to be
 * asked about. The API key is not here: `secret_ref` points into secret_records,
 * the same way a repository credential does.
 */
export const organizationModelSettings = pgTable(
  'organization_model_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * Tried in ascending order. Unique per organisation, so "which is first" has
     * one answer rather than a tie the database would break arbitrarily.
     */
    priority: integer('priority').notNull().default(1),
    /** What a person calls this entry: "9router Paket-Hemat", "DeepSeek fallback". */
    label: text('label'),
    /** False takes it out of the chain without discarding its stored key. */
    enabled: boolean('enabled').notNull().default(true),
    providerId: text('provider_id', { enum: asEnum(MODEL_PROVIDER_IDS) }).notNull(),
    /** Null means "the provider's default", resolved when the provider is built. */
    model: text('model'),
    /** Required for openai-compatible, meaningless for the others. */
    baseUrl: text('base_url'),
    /**
     * Whether this endpoint enforces a JSON schema itself.
     *
     * Per row rather than per deployment because a fallback chain needs both
     * answers at once: DeepSeek rejects response_format json_schema, the local
     * gateway accepts it, and a chain crossing the two cannot work off a single
     * environment value. Null follows AI_STRUCTURED_OUTPUTS.
     */
    structuredOutputs: boolean('structured_outputs'),
    /** Reference into secret_records. Null for mock, which calls nothing. */
    secretRef: text('secret_ref'),
    /**
     * Bumped on every write. The resolver caches built providers against the sum
     * of an organisation's revisions, so any edit, addition or removal changes it
     * and the chain is rebuilt on the next task rather than on the next restart.
     */
    revision: integer('revision').notNull().default(1),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byOrganizationPriority: uniqueIndex('organization_model_settings_priority_idx').on(
      table.organizationId,
      table.priority,
    ),
  }),
);

export const projectConnections = pgTable(
  'project_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    connectionType: text('connection_type', { enum: asEnum(CONNECTION_TYPES) }).notNull(),
    /**
     * Reference into secret_records. Named `secret_ref` rather than
     * `encrypted_credentials` (Table 3) because the platform holds a pointer,
     * not the ciphertext: see ADR-014.
     */
    secretRef: text('secret_ref'),
    /**
     * What the referenced secret is (ADR-021). A fact about the record rather
     * than something inferred from the remote URL, because guessing would be one
     * more thing to get wrong.
     */
    credentialKind: text('credential_kind', { enum: asEnum(CREDENTIAL_KINDS) })
      .notNull()
      .default('token'),
    /**
     * The SSH host key for this remote, in known_hosts form.
     *
     * Supplied by an operator for the strict posture, or recorded by the platform
     * on first contact under `accept-new`. Not a secret - a host's public key is
     * public - so it is stored directly rather than through the secret manager.
     */
    sshHostKey: text('ssh_host_key'),
    status: text('status', { enum: asEnum(CONNECTION_STATUSES) })
      .notNull()
      .default('pending'),
    /** Non-sensitive connection detail: host, account, repository slug. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (table) => ({
    byProject: index('project_connections_project_idx').on(table.projectId),
  }),
);

/**
 * Structured project specification. Persisted rather than inferred from chat
 * history, so that project context survives independently of any conversation.
 */
export const projectSpecifications = pgTable(
  'project_specifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    specification: jsonb('specification').$type<Record<string, unknown>>().notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => ({
    versionUnique: uniqueIndex('project_specifications_project_version_unique').on(
      table.projectId,
      table.version,
    ),
  }),
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: asEnum(AGENT_SESSION_STATUSES) })
      .notNull()
      .default('active'),
    title: text('title'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => ({
    byProject: index('agent_sessions_project_idx').on(table.projectId),
  }),
);

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Short, user-facing identifier in the documented `task_9281` form. The
     * primary key stays a UUID; this is what appears in branch names and in the
     * interface.
     */
    reference: text('reference').notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    prompt: text('prompt').notNull(),
    status: text('status', { enum: asEnum(AGENT_TASK_STATUSES) }).notNull().default('created'),
    branch: text('branch'),
    commitHash: text('commit_hash'),
    /** Structured implementation plan produced in the planning state. */
    plan: jsonb('plan').$type<Record<string, unknown> | null>(),
    /** Files the task reports as modified, with per-file diff statistics. */
    modifiedFiles: jsonb('modified_files').$type<unknown[]>().notNull().default([]),
    /** Validation and test outcome for the task. */
    testResults: jsonb('test_results').$type<Record<string, unknown> | null>(),
    failureReason: text('failure_reason'),
    /**
     * The environment this task targets (ADR-021).
     *
     * Recorded on the task rather than resolved at each step, so a change to the
     * project's environments does not silently redirect a task already running.
     * Null for a task created before environments existed.
     */
    environmentId: uuid('environment_id'),
    /** The commit the AI branch was created from, for the diff base. */
    baseCommit: text('base_commit'),
    /** Aggregate diff statistics, so a list view need not fetch the patch. */
    diffStats: jsonb('diff_stats').$type<Record<string, unknown> | null>(),
    /**
     * The unified diff of the change, retained with the task.
     *
     * Persisted rather than regenerated on demand, because the workspace is
     * destroyed when the run ends and there would otherwise be nothing left to
     * diff. Reviewing the change after the fact is part of the documented
     * workflow, so the patch has to outlive the clone.
     *
     * This is source code, which chapter 12 places within the agent's reach; it
     * is not database records, which are not. Bounded on write so one task cannot
     * store an unbounded blob.
     */
    diffPatch: text('diff_patch'),
    /**
     * True only when NOTHING in the run had a real effect. A Phase 2 task clones,
     * edits and commits for real, so this is false even though validation is
     * still simulated - which is why the field below exists.
     */
    simulated: boolean('simulated').notNull().default(true),
    /**
     * The capability categories whose results were fabricated, e.g.
     * ["validation", "push"]. This is what the portal states, because a single
     * boolean cannot answer both "did anything real happen" and "which of these
     * results can I trust" (ADR-019).
     */
    simulatedCapabilities: jsonb('simulated_capabilities')
      .$type<string[]>()
      .notNull()
      .default([]),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    referenceUnique: uniqueIndex('agent_tasks_reference_unique').on(table.reference),
    byProject: index('agent_tasks_project_created_idx').on(table.projectId, table.createdAt),
    byOrganizationStatus: index('agent_tasks_org_status_idx').on(
      table.organizationId,
      table.status,
    ),
  }),
);

/**
 * Append-only record of everything the agent did. In the absence of Temporal
 * replay this table carries the audit obligation for agent behaviour (ADR-011),
 * so rows are never updated after their terminal status is written.
 */
export const agentActions = pgTable(
  'agent_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    actionType: text('action_type', { enum: asEnum(AGENT_ACTION_TYPES) }).notNull(),
    /** Tool name for a tool action; null for reasoning and transitions. */
    toolName: text('tool_name'),
    input: jsonb('input').$type<Record<string, unknown> | null>(),
    output: jsonb('output').$type<Record<string, unknown> | null>(),
    status: text('status', { enum: asEnum(AGENT_ACTION_STATUSES) }).notNull(),
    /** Populated when the permission validator refused the request. */
    denialReason: text('denial_reason'),
    simulated: boolean('simulated').notNull().default(false),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sequenceUnique: uniqueIndex('agent_actions_task_sequence_unique').on(
      table.taskId,
      table.sequence,
    ),
  }),
);

/**
 * Realtime events, persisted as well as published. The portal replays this table
 * on connect, so a user who reloads mid-task sees the history rather than only
 * events that happen to arrive afterwards.
 */
export const agentTaskEvents = pgTable(
  'agent_task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    status: text('status').notNull(),
    message: text('message').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sequenceUnique: uniqueIndex('agent_task_events_task_sequence_unique').on(
      table.taskId,
      table.sequence,
    ),
  }),
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    action: text('action', { enum: asEnum(APPROVAL_ACTIONS) }).notNull(),
    status: text('status', { enum: asEnum(APPROVAL_STATUSES) }).notNull().default('pending'),
    /** What the approver is being asked to authorise. Never credentials. */
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    /** Reason the policy engine required approval, recorded at request time. */
    requiredReason: text('required_reason').notNull(),
    decisionNote: text('decision_note'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    byTask: index('approvals_task_idx').on(table.taskId),
    byStatus: index('approvals_org_status_idx').on(table.organizationId, table.status),
  }),
);

/**
 * Audit log. Chapter 10 of the brief and chapter 11 of the architecture require
 * that this table never hold passwords, tokens, API keys, raw secrets or
 * production database records. Enforcement is in core/audit/redact.ts, through
 * which every write passes; there is no other insert path.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    /** Redacted, non-sensitive detail only. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byOrganization: index('audit_logs_org_created_idx').on(table.organizationId, table.createdAt),
    byEventType: index('audit_logs_event_type_idx').on(table.eventType),
  }),
);

// ---------------------------------------------------------------------------
// Relations, for typed relational queries.
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMembers),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  projects: many(projects),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [organizationMembers.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  connections: many(projectConnections),
  specifications: many(projectSpecifications),
  tasks: many(agentTasks),
}));

export const agentTasksRelations = relations(agentTasks, ({ one, many }) => ({
  project: one(projects, { fields: [agentTasks.projectId], references: [projects.id] }),
  session: one(agentSessions, {
    fields: [agentTasks.sessionId],
    references: [agentSessions.id],
  }),
  actions: many(agentActions),
  events: many(agentTaskEvents),
  approvals: many(approvals),
}));

export const agentActionsRelations = relations(agentActions, ({ one }) => ({
  task: one(agentTasks, { fields: [agentActions.taskId], references: [agentTasks.id] }),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  task: one(agentTasks, { fields: [approvals.taskId], references: [agentTasks.id] }),
}));

// ---------------------------------------------------------------------------
// Row types. Inferred from the schema so the database is the single source of
// truth for shape; API response shapes are declared separately per module.
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type OrganizationRow = typeof organizations.$inferSelect;
export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type ProjectConnectionRow = typeof projectConnections.$inferSelect;
export type ProjectSpecificationRow = typeof projectSpecifications.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type AgentActionRow = typeof agentActions.$inferSelect;
export type AgentTaskEventRow = typeof agentTaskEvents.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;

// ---------------------------------------------------------------------------
// Phase 2 additions (ADR-019).
// ---------------------------------------------------------------------------

/**
 * Per-task workspaces.
 *
 * The row exists before the clone begins, which is what makes an orphaned
 * directory findable after a worker dies: a directory with no row would be
 * invisible to the reclaimer. `root_path` is the platform's own path and is never
 * returned through the API.
 */
export const agentWorkspaces = pgTable(
  'agent_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short handle used in logs and in the workspace directory name. */
    workspaceRef: text('workspace_ref').notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    rootPath: text('root_path').notNull(),
    branch: text('branch').notNull(),
    baseCommit: text('base_commit'),
    status: text('status', {
      enum: asEnum(['allocated', 'ready', 'released', 'failed', 'retained']),
    })
      .notNull()
      .default('allocated'),
    bytesUsed: integer('bytes_used').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (table) => ({
    refUnique: uniqueIndex('agent_workspaces_ref_unique').on(table.workspaceRef),
    byStatus: index('agent_workspaces_status_idx').on(table.status),
    byTask: index('agent_workspaces_task_idx').on(table.taskId),
  }),
);

/**
 * Persistent project context - the "project memory" of chapter 12.
 *
 * Holds only technical facts derived from the repository: the Odoo series, the
 * modules present, the repository's shape. It never holds customer records, and
 * the analysis that populates it reads manifest and source text without executing
 * anything.
 *
 * One row per project, upserted by each analysis, with the task that last wrote
 * it recorded so a surprising value can be traced to the run that produced it.
 */
export const projectMemory = pgTable(
  'project_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Detected from the repository, which may differ from the declared value. */
    detectedOdooVersion: text('detected_odoo_version'),
    pythonVersion: text('python_version'),
    /** Addon modules found, with their manifest name, version and dependencies. */
    modules: jsonb('modules').$type<unknown[]>().notNull().default([]),
    /** Top-level shape of the repository: addon roots, file counts by extension. */
    repositoryStructure: jsonb('repository_structure')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Technical notes accumulated by analysis. Never customer data. */
    notes: jsonb('notes').$type<unknown[]>().notNull().default([]),
    updatedByTaskId: uuid('updated_by_task_id'),
    ...timestamps,
  },
  (table) => ({
    projectUnique: uniqueIndex('project_memory_project_unique').on(table.projectId),
  }),
);

export type AgentWorkspaceRow = typeof agentWorkspaces.$inferSelect;
export type ProjectMemoryRow = typeof projectMemory.$inferSelect;

// ---------------------------------------------------------------------------
// Phase 3 additions (ADR-020).
// ---------------------------------------------------------------------------

/**
 * A record of every model call.
 *
 * Two things make this worth its own table. First, cost and behaviour: a task
 * that consumed thirty thousand tokens or halted on a budget is something an
 * operator needs to see, and the action log is the wrong shape for it.
 *
 * Second, and more important, it is the evidence that the AI data boundary ran.
 * `boundary_findings` records what was removed on the way out and on the way back;
 * `boundary_refused` records a call that was stopped entirely. A deployment can
 * therefore answer "what have we sent to this provider" with something better
 * than an assurance.
 *
 * What it does not hold is the prompt or the response. Those are customer source
 * code, and storing every one of them would build exactly the corpus chapter 12
 * exists to prevent.
 */
export const agentModelCalls = pgTable(
  'agent_model_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** `planning` or `implementation`. */
    operation: text('operation').notNull(),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    /** False for the scripted provider: no network call was made. */
    calledExternalService: boolean('called_external_service').notNull().default(false),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    steps: integer('steps').notNull().default(1),
    toolCalls: integer('tool_calls').notNull().default(0),
    /** Rule names and counts only; never the material that matched. */
    boundaryFindings: jsonb('boundary_findings').$type<unknown[]>().notNull().default([]),
    redactionCount: integer('redaction_count').notNull().default(0),
    boundaryRefused: boolean('boundary_refused').notNull().default(false),
    /** Why the loop stopped, when it was not because the model finished. */
    haltReason: text('halt_reason'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byTask: index('agent_model_calls_task_idx').on(table.taskId),
    byOrganization: index('agent_model_calls_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
  }),
);

export type AgentModelCallRow = typeof agentModelCalls.$inferSelect;

// ---------------------------------------------------------------------------
// Pre-Phase 5 safety additions (ADR-021).
// ---------------------------------------------------------------------------

/**
 * The environments a project has.
 *
 * In Odoo.sh an environment is a branch, so this is the mapping from a name a
 * person uses to the branch the platform clones. `kind` is what the platform
 * reasons about: a task targeting a `production` environment is refused outright,
 * because the MVP has no production deployment path and a gate in front of a
 * capability that does not exist is worse than a closed door.
 *
 * Declared at project creation, because that is when the person creating the
 * project knows which branch is which. A project created without them gets one
 * `development` environment from its default branch, so nothing is silently
 * treated as production.
 */
export const projectEnvironments = pgTable(
  'project_environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** What a person calls it: "Production", "Staging", "Feature QA". */
    name: text('name').notNull(),
    /** The branch this environment is. */
    branch: text('branch').notNull(),
    kind: text('kind', { enum: asEnum(ENVIRONMENT_KINDS) }).notNull(),
    /** The environment a task targets when none is named. Never production. */
    isDefaultTarget: boolean('is_default_target').notNull().default(false),
    ...timestamps,
  },
  (table) => ({
    nameUnique: uniqueIndex('project_environments_project_name_unique').on(
      table.projectId,
      table.name,
    ),
    branchUnique: uniqueIndex('project_environments_project_branch_unique').on(
      table.projectId,
      table.branch,
    ),
    byProject: index('project_environments_project_idx').on(table.projectId),
  }),
);

export type ProjectEnvironmentRow = typeof projectEnvironments.$inferSelect;
