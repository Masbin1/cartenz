import {
  bigint,
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
  GIT_TRANSPORTS,
  MODEL_PROVIDER_IDS,
  AGENT_ACTION_STATUSES,
  AGENT_ACTION_TYPES,
  AGENT_SESSION_STATUSES,
  AGENT_TASK_KINDS,
  APPROVAL_ACTIONS,
  APPROVAL_STATUSES,
  BACKUP_REASONS,
  BACKUP_STATUSES,
  CONNECTION_STATUSES,
  CONNECTION_TYPES,
  ODOO_EDITIONS,
  PREVIEW_STATUSES,
  PROJECT_ACCESS_REQUEST_STATUSES,
  PROJECT_PROVISIONING_STATUSES,
  PROJECT_TYPES,
  USER_REGIONS,
} from '../enums';
import { AGENT_TASK_STATUSES } from '../../agent/task-state';

/**
 * Persistent schema. Table 3 of the Technical Architecture is the source; the
 * additions are `refresh_tokens` (ADR-015), `secret_records` (ADR-014),
 * `project_specifications` and `agent_task_events`.
 *
 * Two conventions hold throughout:
 *
 *  1. Region isolation. Every row that can be reached by a request carries a
 *     `region` or `project_id`, either directly or through exactly one hop.
 *     Queries filter on it, and the authorisation service is the only place that
 *     decides which region a request may see.
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
    /**
     * The region this account works in (ADR-044). Chosen at registration and
     * changeable by an admin afterwards. It is the access boundary: a regular
     * user sees the projects of their own region plus any they were granted.
     */
    region: text('region', { enum: asEnum(USER_REGIONS) }).notNull().default('indonesia'),
    /**
     * Whether this account is an admin. One flag rather than a role hierarchy:
     * an admin sees every region, opens every project, and is the only rank that
     * may grant access or approve an agent action.
     */
    isAdmin: boolean('is_admin').notNull().default(false),
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
    // Null for a deployment-wide secret (the one global scope), else the project
    // the value belongs to.
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
    // Null for the one global scope; otherwise the project the key seals.
    projectId: uuid('project_id'),
    wrappedKey: text('wrapped_key').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // At most one key per scope. Postgres treats NULLs as distinct in a unique
    // index, so the global (project_id IS NULL) row is guarded by its own index
    // below rather than by this one.
    scopeUnique: uniqueIndex('secret_data_keys_project_unique')
      .on(table.projectId)
      .where(sql`${table.projectId} is not null`),
    globalUnique: uniqueIndex('secret_data_keys_global_unique')
      .on(table.projectId)
      .where(sql`${table.projectId} is null`),
  }),
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The region this project belongs to (ADR-044). Chosen at creation; it is
     * the access boundary a regular user's project list filters on.
     */
    region: text('region', { enum: asEnum(USER_REGIONS) }).notNull().default('indonesia'),
    name: text('name').notNull(),
    description: text('description'),
    projectType: text('project_type', { enum: asEnum(PROJECT_TYPES) }).notNull(),
    odooVersion: text('odoo_version'),
    /**
     * Community or Enterprise (ADR-037). Governs whether the generated
     * `odoo.conf` lists the enterprise addons path. Defaults to enterprise, the
     * behaviour before this column existed.
     */
    odooEdition: text('odoo_edition', { enum: asEnum(ODOO_EDITIONS) })
      .notNull()
      .default('enterprise'),
    defaultBranch: text('default_branch').notNull().default('main'),
    // Repository URL only. Credentials live behind a connection reference.
    repositoryUrl: text('repository_url'),
    /**
     * How git reaches this project's remote (ADR-059): 'auto' (read from the
     * URL, the behaviour before the column existed), 'ssh' or 'https'.
     *
     * Explicit because the two are not interchangeable: an HTTPS remote with
     * only an SSH key registered makes `git push` ask for a username, and a
     * process with no terminal cannot answer. The service rewrites
     * `repository_url` when this is anything but 'auto', so the URL the agent
     * clones from and the scheme git pushes with never disagree.
     */
    gitTransport: text('git_transport', { enum: asEnum(GIT_TRANSPORTS) })
      .notNull()
      .default('auto'),
    /**
     * The credential this project uses, overriding the ADR-058 deployment
     * default. A reference into `git_credentials` rather than a copy, so
     * rotating the registered credential reaches this project without anyone
     * editing it — the same sharing `project_connections.secret_ref` relies on.
     *
     * Null means "no project override": resolution falls back to the project's
     * own connection, then to the registered default for the remote's host.
     */
    gitCredentialId: uuid('git_credential_id').references(() => gitCredentials.id, {
      onDelete: 'set null',
    }),
    /**
     * The account an HTTPS remote authenticates as, when it is not derived from
     * the token's owner. Null means the built-in convention
     * (`x-access-token`), which is what a GitHub App or fine-grained PAT wants.
     */
    gitUsername: text('git_username'),
    /**
     * Non-sensitive environment configuration: Odoo addon paths, Python
     * version, target build environment. Never credentials.
     */
    environmentConfig: jsonb('environment_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /**
     * The live instance this project's AI-created directory was provisioned
     * into (ADR-039), by the operator's own create_project /
     * create_project_enterprise scripts — never written by any code path
     * other than ProjectProvisioningService.
     *
     * `none` on every project scaffolded before this existed, and on every
     * project created while PROJECT_PROVISIONING_ENABLED is false: the
     * platform never silently starts provisioning something that used to be a
     * scaffold-only project.
     */
    provisioningStatus: text('provisioning_status', { enum: asEnum(PROJECT_PROVISIONING_STATUSES) })
      .notNull()
      .default('none'),
    /** The HTTP port allocated for this project's Odoo instance, once provisioned. */
    provisioningPort: integer('provisioning_port'),
    /** The public URL — http://<name>.<base-domain> — once nginx is configured. */
    provisioningUrl: text('provisioning_url'),
    /** The last error message from a failed provisioning run, for the portal to show. */
    provisioningError: text('provisioning_error'),
    provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
    /**
     * The PostgreSQL database name create_project/create_project_enterprise
     * created (ADR-040) — always equal to the project's technicalName/directory
     * name, but stored explicitly so the portal's connection panel does not have
     * to re-derive it from provisioningUrl.
     */
    provisioningDatabaseName: text('provisioning_database_name'),
    /**
     * Reference into secret_records (ADR-014, ADR-040) for the Odoo master
     * password create_project/create_project_enterprise generates and prints on
     * success. Never the plaintext value itself — that is written once by
     * ProjectProvisioningService immediately after the script prints it, and is
     * read back only through the dedicated reveal endpoint, gated to
     * admin/owner. Null for every project scaffolded before this existed, and
     * for one whose provisioning failed before a password was ever produced.
     */
    provisioningMasterPasswordRef: text('provisioning_master_password_ref'),
    /**
     * HTTPS issuance status for the provisioned instance (ADR-040): 'none' (not
     * attempted — HTTPS disabled on this deployment, or the project is
     * scaffold-only), 'pending', 'issued' (certbot ran and the Nginx vhost now
     * redirects to TLS), 'failed' (certbot ran and did not succeed; the instance
     * stays reachable over plain HTTP, and provisioningUrl is not upgraded).
     */
    httpsStatus: text('https_status', { enum: ['none', 'pending', 'issued', 'failed'] })
      .notNull()
      .default('none'),
    /** The last error message from a failed HTTPS issuance, for the portal to show. */
    httpsError: text('https_error'),
    /**
     * Agent permissions per chapter 11. Held per project and independent of
     * user roles. Defaults are applied by the application, not the column, so
     * that the data-blind posture is expressed in one place in code.
     */
    agentPermissions: jsonb('agent_permissions')
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    /**
     * When true, this project's tasks may only use model providers whose base
     * URL is loopback (ADR-055): nothing leaves the host for this project. A
     * client who will not accept off-host egress sets this, and the resolver
     * refuses the deployment's external providers rather than filtering them
     * silently - a task that cannot run must say why.
     */
    localProviderOnly: boolean('local_provider_only').notNull().default(false),
    /**
     * Restart status for a project's instance (ADR-057): 'none' (never
     * restarted through the platform), 'pending' (queued, the worker is
     * running the upgrade), 'restarted' (the unit came back up on the new
     * code), 'failed' (the upgrade failed and the code was rolled back to
     * what the instance was serving before).
     */
    restartStatus: text('restart_status', {
      enum: ['none', 'pending', 'restarted', 'failed'],
    })
      .notNull()
      .default('none'),
    /** The last error message from a failed restart, for the portal to show. */
    restartError: text('restart_error'),
    /** The commit the instance was serving as of its last successful restart. */
    restartCommit: text('restart_commit'),
    /** The branch that commit came from. */
    restartBranch: text('restart_branch'),
    restartedAt: timestamp('restarted_at', { withTimezone: true }),
    /**
     * The linked instance's own URL (ADR-050, ADR-054): the customer's
     * odoo.sh/on-premise project the operator is connecting to, so its
     * database manager can later be reached for a restore. Distinct from
     * `provisioningUrl`, which is the Cartenz-hosted replica this platform
     * runs itself — the two must never be presented as the same instance.
     */
    projectUrl: text('project_url'),
    /** The database name at `projectUrl`, when the operator supplied one. */
    projectDatabase: text('project_database'),
    /**
     * True when `projectUrl` names an Odoo.sh project rather than a plain
     * on-premise host — Odoo.sh's own database manager and branch model
     * differ from a bare on-premise instance's, so a restore path reads this
     * to choose which one it is talking to.
     */
    isOdoosh: boolean('is_odoosh').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    byRegion: index('projects_region_idx').on(table.region),
    // One flat space: project names are unique across the deployment, so a
    // branch name, a workspace directory and a URL segment collide loudly rather
    // than silently in two places.
    nameUnique: uniqueIndex('projects_name_unique').on(table.name),
  }),
);

/**
 * The model providers configured for the whole deployment (ADR-023, ADR-044).
 *
 * One row per provider, ordered by `priority`, so the failover chain is a list
 * an operator can see and reorder rather than a single environment variable.
 * Region is an access boundary, not a configuration boundary, so there is one
 * global chain. The API key is not here: `secret_ref` points into
 * secret_records, the same way a repository credential does.
 */
export const modelSettings = pgTable(
  'model_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Tried in ascending order. Unique, so "which is first" has one answer
     * rather than a tie the database would break arbitrarily.
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
     * Bumped on every write. The resolver caches built providers against the
     * chain's total revision, so any edit, addition or removal changes it and
     * the chain is rebuilt on the next task rather than on the next restart.
     */
    revision: integer('revision').notNull().default(1),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    priorityUnique: uniqueIndex('model_settings_priority_unique').on(table.priority),
  }),
);

/**
 * Where this deployment's Odoo estate lives (ADR-033, ADR-044).
 *
 * One row for the whole deployment, as the estate is operator config rather than
 * a per-region boundary. Filesystem locations rather than credentials, so they
 * are stored in plain columns and displayed in the portal — being able to see and
 * correct them is the reason they moved out of the environment.
 */
export const odooSettings = pgTable('odoo_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The Odoo base checkout, read-only to the agent. */
  basePath: text('base_path'),
  /** The enterprise addons, read-only to the agent. */
  enterprisePath: text('enterprise_path'),
  /** Where a new project's directory is created. */
  projectsRoot: text('projects_root'),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  ...timestamps,
});

export type OdooSettingsRow = typeof odooSettings.$inferSelect;

/**
 * Deployment-wide git credentials (ADR-021, ADR-058).
 *
 * One row per credential an operator registers once, so a project-creation form
 * does not ask for the same private key every time. Scope is the deployment, not
 * a project: the value is sealed under the single global data key
 * (`projectId: null`), and `connected_projects` count is derived at read time.
 *
 * The secret itself is never in this table — `secretRef` points into
 * `secret_records`, exactly as `project_connections.secretRef` does. A
 * connection created for a project that used a default credential stores this
 * same reference rather than copying the value, so rotating the default reaches
 * every project that never overrode it.
 */
export const gitCredentials = pgTable(
  'git_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What a person calls it: "GitHub - Masbin1". */
    label: text('label').notNull(),
    /** Reference into secret_records. Never null: a row without a value is pointless. */
    secretRef: text('secret_ref').notNull(),
    credentialKind: text('credential_kind', { enum: asEnum(CREDENTIAL_KINDS) })
      .notNull()
      .default('ssh_key'),
    /**
     * The hosts this credential may be presented to, lowercased and without a
     * port. Empty means "any host", which is the honest default for a key an
     * operator registered deliberately - and the reason this is metadata rather
     * than a security control: the platform already refuses a credential for a
     * remote it was not registered against when the host is listed.
     */
    hosts: jsonb('hosts').$type<string[]>().notNull().default([]),
    /**
     * The default to use when a form supplies no credential and no entry is
     * chosen. At most one row is true; the service enforces that on write.
     */
    isDefault: boolean('is_default').notNull().default(false),
    /**
     * A registered credential is held back from use without deleting it, and
     * from being the default. Separate from `isDefault` because disabling the
     * default is a distinct intent from choosing a different one.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** Free-text note, e.g. which GitHub account the key authenticates as. */
    note: text('note'),
    /**
     * Whether the registering operator ever proved the credential works, and
     * against what. Written only by the verify action, so it is a record of a
     * real test rather than of an intention.
     */
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastVerifyError: text('last_verify_error'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => ({
    labelUnique: uniqueIndex('git_credentials_label_unique').on(table.label),
    /**
     * At most one default row, enforced by the database rather than by the
     * service alone: a partial unique index means a race between two admins
     * setting a default cannot leave two, which a read-then-write in the service
     * could.
     */
    singleDefault: uniqueIndex('git_credentials_single_default')
      .on(table.isDefault)
      .where(sql`${table.isDefault}`),
    byLabel: index('git_credentials_label_idx').on(table.label),
  }),
);

export type GitCredentialRow = typeof gitCredentials.$inferSelect;

/**
 * Per-version Odoo source repositories (centralized version catalog).
 *
 * Allows registering a full Odoo source tree per version (e.g. 17.0, 18.0)
 * so that new installations can reference the actual Odoo codebase instead of
 * generating boilerplate via AI. One row per version; the active row for a
 * version is what the agent reads as reference source.
 */
export const odooVersionRepositories = pgTable(
  'odoo_version_repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Odoo version this repository serves, e.g. '17.0'. */
    version: text('version').notNull(),
    /** The Odoo base checkout for this version (holds odoo-bin, addons/). */
    basePath: text('base_path').notNull(),
    /** The enterprise addons for this version, when available. */
    enterprisePath: text('enterprise_path'),
    /** Whether this repository is available for new projects. */
    isActive: boolean('is_active').notNull().default(true),
    /** Optional description for operators. */
    description: text('description'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => ({
    versionUnique: uniqueIndex('odoo_version_repositories_version_unique').on(table.version),
  }),
);

export type OdooVersionRepositoryRow = typeof odooVersionRepositories.$inferSelect;

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

export const projectDocuments = pgTable(
  'project_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Original filename as uploaded; shown to people, never used as a path. */
    filename: text('filename').notNull(),
    /** Declared MIME type, allowlisted at upload (ADR-030). */
    mimeType: text('mime_type').notNull(),
    /** Uploaded byte size, before extraction. */
    byteSize: integer('byte_size').notNull(),
    /**
     * The document as extracted text (ADR-030). The original binary is not
     * stored. Bounded on write; a document whose extraction yields no text is
     * refused rather than stored empty. For an image attachment (ADR-042) this
     * holds a short placeholder (`[Image: <name>]`) and the bytes live in
     * `imageDataBase64` instead.
     */
    textContent: text('text_content').notNull(),
    /**
     * Base64 of the original image bytes for an image attachment (ADR-042), null
     * for a text document. Set together with an `image/*` MIME type; the pair is
     * what distinguishes an image attachment from a text one.
     */
    imageDataBase64: text('image_data_base64'),
    ...timestamps,
  },
  (table) => ({
    byProject: index('project_documents_project_idx').on(table.projectId),
  }),
);

export type ProjectDocumentRow = typeof projectDocuments.$inferSelect;

/**
 * Who may open a project (ADR-043).
 *
 * The row is the whole grant: it carries no role, no permission set and no
 * expiry. What a person may do inside a project stays governed by their
 * organisation role, so that a single authorisation decision never has to choose
 * between two ranks for the same person.
 *
 * Owners and admins are absent by design - they reach every project by rank, and
 * a row for them would imply a revoke that would not work.
 */
export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for rows the migration backfilled: nobody decided them. */
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => ({
    grantUnique: uniqueIndex('project_members_project_user_unique').on(
      table.projectId,
      table.userId,
    ),
    // The project list asks "everything this user may open" on every page load.
    byUser: index('project_members_user_idx').on(table.userId),
  }),
);

/**
 * A request for access to a project, and what was decided (ADR-043).
 *
 * One pending request per (project, user) is enforced by a partial unique index
 * in the migration rather than by a read-then-write, for the reason the approval
 * dedup in 0007 was: two parallel requests can both read no pending row and both
 * insert, and the duplicate then sits in the queue forever.
 */
export const projectAccessRequests = pgTable(
  'project_access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Free text from the requester. Optional: a reason should not be a toll gate. */
    reason: text('reason'),
    status: text('status', { enum: asEnum(PROJECT_ACCESS_REQUEST_STATUSES) })
      .notNull()
      .default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Shown back to the requester, so a refusal can say why. */
    decisionNote: text('decision_note'),
    ...timestamps,
  },
  (table) => ({
    byProject: index('project_access_requests_project_idx').on(table.projectId),
    byUser: index('project_access_requests_user_idx').on(table.userId),
  }),
);

/**
 * An ephemeral preview instance (ADR-052).
 *
 * One row per preview, the most recent per project being the live one. It
 * records what the root-run script built so the portal can show a link and a
 * remaining time, and so a crashed worker's preview can be found and torn down.
 * No column here holds a secret: the preview's database is the standard
 * baseline, and the draft is a patch on disk only for the life of the build.
 */
export const projectPreviews = pgTable(
  'project_previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The task whose retained draft is being previewed. */
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    /**
     * A short opaque token naming this preview on the host: it is part of the
     * database name, the systemd unit name and the preview directory, so it is
     * validated as a plain lowercase token by both the script and the guard.
     */
    ref: text('ref').notNull(),
    status: text('status', { enum: asEnum(PREVIEW_STATUSES) }).notNull().default('creating'),
    branch: text('branch').notNull(),
    baseCommit: text('base_commit'),
    odooVersion: text('odoo_version'),
    odooEdition: text('odoo_edition'),
    region: text('region'),
    port: integer('port'),
    /** The URL a reviewer opens. Null until the instance is up. */
    url: text('url'),
    /** The scratch database and directory, recorded so a stop can be exact. */
    databaseName: text('database_name'),
    /** Why the build failed, when it did. */
    error: text('error'),
    /** When the instance is torn down, however it was started. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    startedByUserId: uuid('started_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => ({
    refUnique: uniqueIndex('project_previews_ref_unique').on(table.ref),
    // "the live preview for this project" is the query on every status read and
    // every start's replacement check.
    byProject: index('project_previews_project_idx').on(table.projectId),
    byStatus: index('project_previews_status_idx').on(table.status),
    byExpiry: index('project_previews_expires_idx').on(table.expiresAt),
  }),
);

export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type ProjectAccessRequestRow = typeof projectAccessRequests.$inferSelect;
export type ProjectPreviewRow = typeof projectPreviews.$inferSelect;

/**
 * One per-client backup (ADR-054).
 *
 * The row is a record of a host action, not the backup itself: the archive
 * lives under /opt/odoo/backups and is owned by root, restorable without this
 * platform. `path` and `backupId` name what the root-run script produced so an
 * operator can find it; `taskId` records which task's push it was taken for,
 * when it was automatic.
 */
export const projectBackups = pgTable(
  'project_backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The task whose pre-push backup this was, when it was automatic. */
    taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'set null' }),
    status: text('status', { enum: asEnum(BACKUP_STATUSES) }).notNull().default('running'),
    reason: text('reason', { enum: asEnum(BACKUP_REASONS) }).notNull().default('manual'),
    /** The script's own id for the run (a UTC timestamp token). */
    backupId: text('backup_id'),
    /** The backup directory on the host, for the operator. Never a secret. */
    path: text('path'),
    /** Total bytes of the backup directory, as reported by the script. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Why it failed, when it did. */
    error: text('error'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    // "the backups of this project, newest first" is the only list query.
    byProject: index('project_backups_project_idx').on(table.projectId),
    byTask: index('project_backups_task_idx').on(table.taskId),
  }),
);

export type ProjectBackupRow = typeof projectBackups.$inferSelect;

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
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    prompt: text('prompt').notNull(),
    /** Which product shape this task is: a development run or a conversation (ADR-029). */
    kind: text('kind', { enum: asEnum(AGENT_TASK_KINDS) }).notNull().default('change'),
    /** The natural-language answer a chat task produced (ADR-029). Null for a change task. */
    answer: text('answer'),
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
     * Documents attached to the task (ADR-030), referenced by id. The workflow
     * loads them and passes each as a prompt part; they are never concatenated
     * into `prompt`. A task runs with the text captured at creation time even if
     * a document is later deleted, so the ids are what is stored here.
     */
    attachedDocumentIds: jsonb('attached_document_ids').$type<string[]>().notNull().default([]),
    /**
     * The environment this task targets (ADR-021).
     *
     * Recorded on the task rather than resolved at each step, so a change to the
     * project's environments does not silently redirect a task already running.
     * Null for a task created before environments existed.
     */
    environmentId: uuid('environment_id'),
    /** The commit the task's branch was created from, for the diff base. */
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
    byStatus: index('approvals_status_idx').on(table.status),
    // At most one pending approval per (task, action): the request path dedupes
    // with a read-modify-write, and this partial index makes the dedup a schema
    // fact so two parallel requests cannot both insert a pending row (ADR-029).
    pendingUnique: uniqueIndex('approvals_task_action_pending_unique')
      .on(table.taskId, table.action)
      .where(sql`${table.status} = 'pending'`),
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
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    /** Redacted, non-sensitive detail only. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byCreated: index('audit_logs_created_idx').on(table.createdAt),
    byEventType: index('audit_logs_event_type_idx').on(table.eventType),
  }),
);

// ---------------------------------------------------------------------------
// Relations, for typed relational queries.
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(projectMembers),
}));

export const projectsRelations = relations(projects, ({ many }) => ({
  connections: many(projectConnections),
  specifications: many(projectSpecifications),
  tasks: many(agentTasks),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const projectAccessRequestsRelations = relations(projectAccessRequests, ({ one }) => ({
  project: one(projects, {
    fields: [projectAccessRequests.projectId],
    references: [projects.id],
  }),
  user: one(users, { fields: [projectAccessRequests.userId], references: [users.id] }),
}));

export const projectPreviewsRelations = relations(projectPreviews, ({ one }) => ({
  project: one(projects, { fields: [projectPreviews.projectId], references: [projects.id] }),
  task: one(agentTasks, { fields: [projectPreviews.taskId], references: [agentTasks.id] }),
  startedBy: one(users, {
    fields: [projectPreviews.startedByUserId],
    references: [users.id],
  }),
}));

export const projectBackupsRelations = relations(projectBackups, ({ one }) => ({
  project: one(projects, { fields: [projectBackups.projectId], references: [projects.id] }),
  task: one(agentTasks, { fields: [projectBackups.taskId], references: [agentTasks.id] }),
  createdBy: one(users, {
    fields: [projectBackups.createdByUserId],
    references: [users.id],
  }),
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
    /** `planning`, `implementation` or `chat`. */
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
    byCreated: index('agent_model_calls_created_idx').on(table.createdAt),
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

// ---------------------------------------------------------------------------
// Web push (ADR-065). A subscription is one browser's registration with a
// push service (its endpoint is that service's URL, unique to the browser
// install); a user with several devices holds several rows.
// ---------------------------------------------------------------------------

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The push service URL the browser registered. Unique: re-subscribing updates the row. */
    endpoint: text('endpoint').notNull(),
    /** The two keys `PushSubscription.toJSON()` returns, needed to encrypt a message to this browser. */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    endpointUnique: uniqueIndex('push_subscriptions_endpoint_unique').on(table.endpoint),
    byUser: index('push_subscriptions_user_idx').on(table.userId),
  }),
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * Per-user, per-event opt-in. A row only exists once a user has changed a
 * default; the service reads a missing row as "all events on, sound on",
 * which is the platform default (ADR-065) and keeps the common case free of
 * a row nobody asked for.
 */
export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  approvalRequired: boolean('approval_required').notNull().default(true),
  taskCompleted: boolean('task_completed').notNull().default(true),
  taskFailed: boolean('task_failed').notNull().default(true),
  soundEnabled: boolean('sound_enabled').notNull().default(true),
  ...timestamps,
});

export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
