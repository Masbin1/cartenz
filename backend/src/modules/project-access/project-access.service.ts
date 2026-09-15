import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import {
  organizationMembers,
  projectAccessRequests,
  projectMembers,
  projects,
  users,
} from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { PROJECT_ACCESS_BYPASS_ROLE } from '../../core/authz/project-access';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { ROLE_RANK, type OrganizationRole } from '../../core/enums';
import type {
  DecideAccessRequestDto,
  GrantProjectAccessDto,
  RequestProjectAccessDto,
} from './dto/project-access.dto';

/** How a member reaches a project, and whether that can be taken away. */
export interface ProjectAccessDescription {
  readonly hasAccess: boolean;
  readonly source: 'role' | 'creator' | 'grant' | 'none';
  readonly revocable: boolean;
}

/**
 * How the panel should describe one member's standing on one project (ADR-043).
 *
 * Pure, and exported, because the distinction it draws is the one the UI gets
 * wrong if left to infer: only a grant is revocable. Rank and authorship are
 * not, and offering a toggle for them would promise something clearing it
 * cannot deliver.
 */
export function describeProjectAccess(
  role: OrganizationRole,
  isCreator: boolean,
  hasGrant: boolean,
): ProjectAccessDescription {
  if (ROLE_RANK[role] >= ROLE_RANK[PROJECT_ACCESS_BYPASS_ROLE]) {
    return { hasAccess: true, source: 'role', revocable: false };
  }

  if (isCreator) {
    return { hasAccess: true, source: 'creator', revocable: false };
  }

  if (hasGrant) {
    return { hasAccess: true, source: 'grant', revocable: true };
  }

  return { hasAccess: false, source: 'none', revocable: false };
}

/**
 * Granting, revoking and deciding access to a single project (ADR-043).
 *
 * Separate from ProjectsService, which is already large and answers a different
 * question. Everything here resolves authority through AuthorizationService
 * rather than reading roles itself.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every member of the organisation with their standing on this project.
   *
   * Not only the granted rows: the panel's question is "who can open this", and
   * an admin missing from the list while being able to open it would read as a
   * bug in the panel rather than as the rank rule working.
   */
  async listMembers(user: AuthenticatedUser, projectId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    const [project] = await this.database.db
      .select({ createdByUserId: projects.createdByUserId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const members = await this.database.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, context.organizationId))
      .orderBy(users.name);

    const granted = new Set(
      (
        await this.database.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(eq(projectMembers.projectId, projectId))
      ).map((row) => row.userId),
    );

    return members.map((member) => ({
      ...member,
      ...describeProjectAccess(
        member.role as OrganizationRole,
        project?.createdByUserId === member.userId,
        granted.has(member.userId),
      ),
    }));
  }

  /** Give a member access to this project. Idempotent. */
  async grant(user: AuthenticatedUser, projectId: string, dto: GrantProjectAccessDto) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    await this.assertOrganizationMember(context.organizationId, dto.userId);

    await this.database.db
      .insert(projectMembers)
      .values({
        projectId,
        userId: dto.userId,
        grantedByUserId: user.userId,
      })
      .onConflictDoNothing();

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_GRANTED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { grantedUserId: dto.userId },
    });

    return { granted: true };
  }

  /** Withdraw a grant. Leaves access that comes from rank or authorship alone. */
  async revoke(user: AuthenticatedUser, projectId: string, memberUserId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    await this.database.db
      .delete(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, memberUserId)),
      );

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_REVOKED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { revokedUserId: memberUserId },
    });

    return { revoked: true };
  }

  /**
   * Ask for access to a project you cannot open.
   *
   * Authority is resolved through requireOrganizationMember rather than
   * requireProjectAccess: a person who could already open the project has
   * nothing to ask for, and a person who cannot must still be able to ask.
   */
  async request(user: AuthenticatedUser, projectId: string, dto: RequestProjectAccessDto) {
    const [project] = await this.database.db
      .select({ id: projects.id, organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Membership of the project's organisation, so a request cannot be aimed at
    // a project in an organisation the caller has nothing to do with.
    await this.authz.requireOrganizationMember(user, project.organizationId);

    const [existing] = await this.database.db
      .select({ id: projectAccessRequests.id })
      .from(projectAccessRequests)
      .where(
        and(
          eq(projectAccessRequests.projectId, projectId),
          eq(projectAccessRequests.userId, user.userId),
          eq(projectAccessRequests.status, 'pending'),
        ),
      )
      .limit(1);

    if (existing) {
      throw new BadRequestException('You already have a pending request for this project.');
    }

    const [row] = await this.database.db
      .insert(projectAccessRequests)
      .values({
        projectId,
        userId: user.userId,
        reason: dto.reason ?? null,
        status: 'pending',
      })
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_REQUESTED,
      organizationId: project.organizationId,
      projectId,
      userId: user.userId,
      metadata: { requestId: row.id },
    });

    return row;
  }

  /** Every pending request across the organisation's projects. */
  async listPending(user: AuthenticatedUser, organizationId: string) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');

    return this.database.db
      .select({
        id: projectAccessRequests.id,
        projectId: projectAccessRequests.projectId,
        projectName: projects.name,
        userId: projectAccessRequests.userId,
        userName: users.name,
        userEmail: users.email,
        reason: projectAccessRequests.reason,
        createdAt: projectAccessRequests.createdAt,
      })
      .from(projectAccessRequests)
      .innerJoin(projects, eq(projects.id, projectAccessRequests.projectId))
      .innerJoin(users, eq(users.id, projectAccessRequests.userId))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          eq(projectAccessRequests.status, 'pending'),
        ),
      )
      .orderBy(desc(projectAccessRequests.createdAt));
  }

  /**
   * Approve or reject a request.
   *
   * The decision and the grant are written in one transaction. Two statements
   * would allow a request that reads `approved` with no grant behind it, which
   * nobody would notice until the requester said so.
   */
  async decide(
    user: AuthenticatedUser,
    projectId: string,
    requestId: string,
    dto: DecideAccessRequestDto,
  ) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    const [request] = await this.database.db
      .select({
        id: projectAccessRequests.id,
        userId: projectAccessRequests.userId,
        status: projectAccessRequests.status,
      })
      .from(projectAccessRequests)
      .where(
        and(
          eq(projectAccessRequests.id, requestId),
          eq(projectAccessRequests.projectId, projectId),
        ),
      )
      .limit(1);

    if (!request) {
      throw new NotFoundException('Access request not found');
    }

    if (request.status !== 'pending') {
      throw new BadRequestException(`This request was already ${request.status}.`);
    }

    await this.database.transaction(async (tx) => {
      await tx
        .update(projectAccessRequests)
        .set({
          status: dto.decision,
          decidedByUserId: user.userId,
          decidedAt: new Date(),
          decisionNote: dto.note ?? null,
          updatedAt: new Date(),
        })
        .where(eq(projectAccessRequests.id, requestId));

      if (dto.decision === 'approved') {
        await tx
          .insert(projectMembers)
          .values({
            projectId,
            userId: request.userId,
            grantedByUserId: user.userId,
          })
          .onConflictDoNothing();
      }
    });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_DECIDED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { requestId, decision: dto.decision, requesterUserId: request.userId },
    });

    return { decision: dto.decision };
  }

  private async assertOrganizationMember(organizationId: string, userId: string): Promise<void> {
    const [member] = await this.database.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!member) {
      throw new BadRequestException(
        'That person is not a member of this organisation. Add them to the organisation first.',
      );
    }
  }
}
