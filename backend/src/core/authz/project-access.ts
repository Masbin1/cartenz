/**
 * Why a caller was let into a project, or why they were not (ADR-043, ADR-044).
 *
 * Carried back rather than discarded because the portal renders the difference:
 * an admin who is in by flag has no grant to revoke, and showing them a filled
 * checkbox that does nothing when cleared would read as a broken toggle.
 */
export type ProjectAccessReason = 'admin' | 'creator' | 'grant' | 'none';

export interface ProjectAccessInput {
  readonly userId: string;
  /** Whether the caller is an admin (sees every region and opens every project). */
  readonly isAdmin: boolean;
  /** `projects.created_by_user_id`; null once the creator's account is deleted. */
  readonly createdByUserId: string | null;
  /** Whether a `project_members` row exists for this (project, user). */
  readonly hasGrant: boolean;
}

/**
 * Whether a user may open a project.
 *
 * A pure function, and deliberately so: it is the whole of the rule, it is
 * asserted without a database, and the authorisation service's job is reduced to
 * fetching the three facts it takes.
 *
 * The order is the policy. Admin first, because an admin's access must not depend
 * on a query. Then the creator, so that making a project never locks you out of
 * it. Then the grant. Anything else is refused.
 *
 * Region is deliberately absent: the project list already filters by region, so
 * a user who reaches the open path does so through their own region, a grant, or
 * having created the project — and in each case the grant/creator/admin already
 * decides the answer. Re-checking region here would only deny an admin their
 * cross-region reach.
 */
export function decideProjectAccess(
  input: ProjectAccessInput,
): { allowed: boolean; reason: ProjectAccessReason } {
  if (input.isAdmin) {
    return { allowed: true, reason: 'admin' };
  }

  if (input.createdByUserId !== null && input.createdByUserId === input.userId) {
    return { allowed: true, reason: 'creator' };
  }

  if (input.hasGrant) {
    return { allowed: true, reason: 'grant' };
  }

  return { allowed: false, reason: 'none' };
}
