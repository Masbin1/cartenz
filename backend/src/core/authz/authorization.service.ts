import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { organizationMembers, projects } from '../database/schema';
import { ROLE_RANK, OrganizationRole } from '../enums';
import { AuditService } from '../audit/audit.service';
import { AUDIT_EVENTS } from '../audit/audit-events';
import type { AuthenticatedUser } from './authenticated-user';
import {
  AgentPermission,
  APPROVAL_BEARING_PERMISSIONS,
  resolveAgentPermissions,
} from './agent-permissions';

/** A membership resolved for an authorisation decision. */
export interface MembershipContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
}

/** A project resolved for an authorisation decision, with its organisation. */
export interface ProjectContext {
  readonly projectId: string;
  readonly organizationId: string;
  readonly membership: MembershipContext;
  readonly agentPermissions: Record<AgentPermission, boolean>;
}

/**
 * The single place authorisation is decided (ADR-015).
 *
 * No controller, service or query composes its own permission logic. Every
 * request that touches organisation-scoped data resolves a context here first,
 * and the returned context carries the organisation id that the subsequent query
 * must filter on - so organisation isolation is a consequence of asking, not
 * something each query has to remember.
 *
 * Denials are recorded to the audit trail. A refused request is a security event
 * and is more interesting than a permitted one.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Resolves the caller's membership of an organisation, requiring at least
   * `minimumRole`.
   */
  async requireOrganizationMember(
    user: AuthenticatedUser,
    organizationId: string,
    minimumRole: OrganizationRole = 'viewer',
  ): Promise<MembershipContext> {
    const [membership] = await this.database.db
      .select({
        organizationId: organizationMembers.organizationId,
        userId: organizationMembers.userId,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, user.userId),
        ),
      )
      .limit(1);

    if (!membership) {
      await this.recordDenial(user, organizationId, null, 'not a member of the organisation');
      // Not found rather than forbidden: a non-member must not be able to learn
      // that an organisation exists by the difference in the response.
      throw new NotFoundException('Organisation not found');
    }

    const role = membership.role as OrganizationRole;
    if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
      await this.recordDenial(
        user,
        organizationId,
        null,
        `role ${role} is below the required ${minimumRole}`,
      );
      throw new ForbiddenException(
        `This action requires the ${minimumRole} role or above. Your role is ${role}.`,
      );
    }

    return { organizationId, userId: user.userId, role };
  }

  /**
   * Resolves a project and the caller's standing in its organisation. The
   * project is looked up first and its organisation is taken from the row, so a
   * caller cannot reach a project by naming an organisation they do belong to.
   */
  /**
   * Project access, with the archived state deliberately part of the question.
   *
   * By default an archived project is treated as absent. That is right for the
   * paths that do work — a task must not run against a project someone has put
   * away — and it is why the filter is here rather than in each caller.
   *
   * It is wrong for reading, restoring and deleting, which is what
   * `includeArchived` is for. Without it, archiving is a trapdoor: the project
   * disappears from the list and cannot then be looked at, restored or removed
   * (ADR-024).
   */
  async requireProjectAccess(
    user: AuthenticatedUser,
    projectId: string,
    minimumRole: OrganizationRole = 'viewer',
    options: { includeArchived?: boolean } = {},
  ): Promise<ProjectContext> {
    const scope = options.includeArchived
      ? eq(projects.id, projectId)
      : and(eq(projects.id, projectId), isNull(projects.archivedAt));

    const [project] = await this.database.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        agentPermissions: projects.agentPermissions,
      })
      .from(projects)
      .where(scope)
      .limit(1);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const membership = await this.requireOrganizationMember(
      user,
      project.organizationId,
      minimumRole,
    );

    return {
      projectId: project.id,
      organizationId: project.organizationId,
      membership,
      agentPermissions: resolveAgentPermissions(project.agentPermissions),
    };
  }

  /**
   * Whether a project's agent permissions grant a capability, and whether that
   * capability additionally requires human approval.
   *
   * This answers the policy question only. It does not execute anything and it
   * does not consider user roles: agent permissions are per project and
   * independent of who submitted the task.
   */
  evaluateAgentCapability(
    context: Pick<ProjectContext, 'agentPermissions'>,
    permission: AgentPermission,
  ): { granted: boolean; requiresApproval: boolean } {
    const granted = context.agentPermissions[permission] === true;
    return {
      granted,
      requiresApproval: granted && APPROVAL_BEARING_PERMISSIONS.includes(permission),
    };
  }

  /**
   * Roles permitted to decide an approval. Chapter 11 gives developers the right
   * to approve development actions; production actions are reserved to admin and
   * above.
   */
  requireApprovalAuthority(
    membership: MembershipContext,
    isProductionAction: boolean,
  ): void {
    const required: OrganizationRole = isProductionAction ? 'admin' : 'developer';
    if (ROLE_RANK[membership.role] < ROLE_RANK[required]) {
      throw new ForbiddenException(
        `Deciding this approval requires the ${required} role or above. Your role is ${membership.role}.`,
      );
    }
  }

  private async recordDenial(
    user: AuthenticatedUser,
    organizationId: string | null,
    projectId: string | null,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      event: AUDIT_EVENTS.AUTHORIZATION_DENIED,
      organizationId,
      projectId,
      userId: user.userId,
      metadata: { reason },
    });
  }
}
