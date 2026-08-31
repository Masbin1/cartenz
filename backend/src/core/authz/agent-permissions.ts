import { ORGANIZATION_ROLES, OrganizationRole } from '../enums';

/**
 * Agent permissions (chapter 11 and chapter 12).
 *
 * These are configured per project and are independent of user roles: a project
 * owner cannot make the agent read production records simply by being an owner.
 *
 * The defaults below are the data-blind posture required by chapter 12. Two
 * permissions are `never`: export and backup are described as always denied, so
 * they are not settable at all rather than settable and defaulted to false.
 */
export const AGENT_PERMISSIONS = [
  'repository_read',
  'repository_write',
  'git_commit',
  'git_push',
  'run_tests',
  'database_metadata_read',
  'database_record_read',
  'database_record_write',
  'restart_odoo',
  'production_deploy',
] as const;

export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

/**
 * Capabilities that are never grantable. Present as named constants so that a
 * tool asking for them is refused by name rather than falling through to a
 * generic "unknown permission" path.
 */
export const NEVER_GRANTABLE = ['database_export', 'database_backup'] as const;
export type NeverGrantable = (typeof NEVER_GRANTABLE)[number];

export function isNeverGrantable(capability: string): capability is NeverGrantable {
  return (NEVER_GRANTABLE as readonly string[]).includes(capability);
}

/**
 * Default agent permissions for a new project. Table 7: repository access is
 * allowed, database metadata read is allowed, record read and write are denied,
 * and server-side actions require both permission and approval.
 */
export const DEFAULT_AGENT_PERMISSIONS: Readonly<Record<AgentPermission, boolean>> = {
  repository_read: true,
  repository_write: true,
  git_commit: true,
  git_push: true,
  run_tests: true,
  database_metadata_read: true,
  database_record_read: false,
  database_record_write: false,
  restart_odoo: false,
  production_deploy: false,
};

/**
 * Permissions that require human approval even when granted (chapter 11). A
 * granted permission answers "may the agent ever do this"; this set answers
 * "must a person authorise this instance".
 */
export const APPROVAL_BEARING_PERMISSIONS: readonly AgentPermission[] = [
  'git_push',
  'restart_odoo',
  'production_deploy',
  'database_record_write',
];

/**
 * The minimum organisation role that may change agent permissions. Chapter 11
 * gives configuration of agent permissions to Admin and above.
 */
export const AGENT_PERMISSION_ADMIN_ROLE: OrganizationRole = 'admin';

export function isAgentPermission(value: string): value is AgentPermission {
  return (AGENT_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Merges stored permissions over the defaults. A project row that predates a new
 * permission therefore inherits its default rather than reading as undefined,
 * and an unrecognised stored key is discarded rather than honoured.
 */
export function resolveAgentPermissions(
  stored: Record<string, boolean> | null | undefined,
): Record<AgentPermission, boolean> {
  const resolved = { ...DEFAULT_AGENT_PERMISSIONS };
  if (!stored) return resolved;

  for (const [key, value] of Object.entries(stored)) {
    if (isAgentPermission(key) && typeof value === 'boolean') {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** Guard used when validating a role supplied by a request. */
export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}
