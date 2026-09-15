import { ROLE_RANK, type OrganizationRole } from '../enums';

/**
 * Why a caller was let into a project, or why they were not (ADR-043).
 *
 * Carried back rather than discarded because the portal renders the difference:
 * an admin who is in by rank has no grant to revoke, and showing them a filled
 * checkbox that does nothing when cleared would read as a broken toggle.
 */
export type ProjectAccessReason = 'role' | 'creator' | 'grant' | 'none';

/** The organisation role from which a member reaches every project without a grant. */
export const PROJECT_ACCESS_BYPASS_ROLE: OrganizationRole = 'admin';

export interface ProjectAccessInput {
  /** The caller's role in the project's organisation, already resolved. */
  readonly role: OrganizationRole;
  readonly userId: string;
  /** `projects.created_by_user_id`; null once the creator's account is deleted. */
  readonly createdByUserId: string | null;
  /** Whether a `project_members` row exists for this (project, user). */
  readonly hasGrant: boolean;
}

/**
 * Whether a member of the organisation may open one of its projects.
 *
 * A pure function, and deliberately so: it is the whole of the rule, it is
 * asserted without a database, and the authorisation service's job is reduced to
 * fetching the four facts it takes.
 *
 * The order is the policy. Rank first, because an admin's access must not depend
 * on a query. Then the creator, so that making a project never locks you out of
 * it. Then the grant. Anything else is refused.
 */
export function decideProjectAccess(
  input: ProjectAccessInput,
): { allowed: boolean; reason: ProjectAccessReason } {
  if (ROLE_RANK[input.role] >= ROLE_RANK[PROJECT_ACCESS_BYPASS_ROLE]) {
    return { allowed: true, reason: 'role' };
  }

  if (input.createdByUserId !== null && input.createdByUserId === input.userId) {
    return { allowed: true, reason: 'creator' };
  }

  if (input.hasGrant) {
    return { allowed: true, reason: 'grant' };
  }

  return { allowed: false, reason: 'none' };
}
