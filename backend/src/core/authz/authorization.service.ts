import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { projectMembers, projects } from '../database/schema';
import type { UserRegion } from '../enums';
import { AuditService } from '../audit/audit.service';
import { AUDIT_EVENTS } from '../audit/audit-events';
import type { AuthenticatedUser } from './authenticated-user';
import {
  AgentPermission,
  APPROVAL_BEARING_PERMISSIONS,
  resolveAgentPermissions,
} from './agent-permissions';
import { decideProjectAccess, type ProjectAccessReason } from './project-access';

/**
 * The caller, as the rest of the request pipeline needs them (ADR-044).
 *
 * Returned by requireAdmin so a handler that has already proven the flag does
 * not have to reach back into the token for the region.
 */
export interface AccessContext {
  readonly userId: string;
  readonly region: UserRegion;
  readonly isAdmin: boolean;
}

/** A project resolved for an authorisation decision, with its region. */
export interface ProjectContext {
  readonly projectId: string;
  readonly region: UserRegion;
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly agentPermissions: Record<AgentPermission, boolean>;
  /**
   * Why this caller is allowed in (ADR-043): admin, having created the project,
   * or an explicit grant. Carried so a caller that renders the difference does
   * not have to ask again.
   */
  readonly accessReason: ProjectAccessReason;
  readonly hasProjectGrant: boolean;
}

/**
 * The single place authorisation is decided (ADR-015, ADR-044).
 *
 * No controller, service or query composes its own permission logic. Every
 * request that touches project-scoped data resolves a context here first, and
 * the returned context carries the region the subsequent query must filter on -
 * so region isolation is a consequence of asking, not something each query has
 * to remember.
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
   * Requires the caller to be an admin.
   *
   * The flag is already on the verified token, so this is a comparison rather
   * than a query. Admin status is changed by an operator through the users
   * endpoint, and a demoted account loses the flag at its next token refresh -
   * a window the platform accepts because the alternative is a database read on
   * every settings route.
   */
  async requireAdmin(user: AuthenticatedUser): Promise<AccessContext> {
    if (!user.isAdmin) {
      await this.recordDenial(user, null, 'admin flag required');
      throw new ForbiddenException('This action requires an administrator account.');
    }

    return { userId: user.userId, region: user.region, isAdmin: true };
  }

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
   *
   * `requireAdmin` narrows further than opening the project does: managing
   * grants, environments and settings asks for the flag as well as access.
   */
  async requireProjectAccess(
    user: AuthenticatedUser,
    projectId: string,
    options: { includeArchived?: boolean; requireAdmin?: boolean } = {},
  ): Promise<ProjectContext> {
    const scope = options.includeArchived
      ? eq(projects.id, projectId)
      : and(eq(projects.id, projectId), isNull(projects.archivedAt));

    const [project] = await this.database.db
      .select({
        id: projects.id,
        region: projects.region,
        agentPermissions: projects.agentPermissions,
        createdByUserId: projects.createdByUserId,
      })
      .from(projects)
      .where(scope)
      .limit(1);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    /**
     * The grant is only read when the rule might need it: an admin is in by
     * flag and a creator by the row already fetched, so the common paths cost
     * nothing (ADR-043).
     */
    const bypasses = user.isAdmin || project.createdByUserId === user.userId;

    const hasGrant = bypasses
      ? false
      : (
          await this.database.db
            .select({ id: projectMembers.id })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.projectId, project.id),
                eq(projectMembers.userId, user.userId),
              ),
            )
            .limit(1)
        ).length > 0;

    const decision = decideProjectAccess({
      userId: user.userId,
      isAdmin: user.isAdmin,
      createdByUserId: project.createdByUserId,
      hasGrant,
    });

    if (!decision.allowed) {
      await this.recordDenial(user, project.id, 'no grant for this project');
      /**
       * Forbidden, not NotFound - deliberately. A project's existence is
       * published in the list on purpose, so hiding it here would conceal
       * nothing and would leave the portal's "Request access" button with
       * nothing to point at.
       */
      throw new ForbiddenException(
        'You do not have access to this project. You can request access from the projects list.',
      );
    }

    if (options.requireAdmin && !user.isAdmin) {
      await this.recordDenial(user, project.id, 'admin flag required for this operation');
      throw new ForbiddenException(
        'Managing a project requires an administrator account. You can ask an administrator to do this.',
      );
    }

    return {
      projectId: project.id,
      region: project.region as UserRegion,
      userId: user.userId,
      isAdmin: user.isAdmin,
      agentPermissions: resolveAgentPermissions(project.agentPermissions),
      accessReason: decision.reason,
      hasProjectGrant: decision.reason === 'grant',
    };
  }

  /**
   * Whether a project's agent permissions grant a capability, and whether that
   * capability additionally requires human approval.
   *
   * This answers the policy question only. It does not execute anything and it
   * does not consider the caller: agent permissions are per project and
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
   * Who may decide an approval.
   *
   * Binary since ADR-044: the organisation role hierarchy that once let a
   * developer approve a development action is gone, and with one rank left the
   * answer cannot differ by action. Admins decide everything, everyone else
   * decides nothing.
   */
  requireApprovalAuthority(user: AuthenticatedUser): void {
    if (!user.isAdmin) {
      throw new ForbiddenException('Deciding an approval requires an administrator account.');
    }
  }

  private async recordDenial(
    user: AuthenticatedUser,
    projectId: string | null,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      event: AUDIT_EVENTS.AUTHORIZATION_DENIED,
      projectId,
      userId: user.userId,
      metadata: { reason },
    });
  }
}
