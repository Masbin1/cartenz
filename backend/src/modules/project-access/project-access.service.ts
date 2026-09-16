import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { projectAccessRequests, projectMembers, projects, users } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { AuthorizationService } from '../../core/authz/authorization.service';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import type {
  DecideAccessRequestDto,
  GrantProjectAccessDto,
  RequestProjectAccessDto,
} from './dto/project-access.dto';

/** How a member reaches a project, and whether that can be taken away. */
export interface ProjectAccessDescription {
  readonly hasAccess: boolean;
  readonly source: 'admin' | 'creator' | 'grant' | 'none';
  readonly revocable: boolean;
}

/**
 * How the panel should describe one member's standing on one project (ADR-043).
 *
 * Pure, and exported, because the distinction it draws is the one the UI gets
 * wrong if left to infer: only a grant is revocable. The admin flag and
 * authorship are not, and offering a toggle for them would promise something
 * clearing it cannot deliver.
 */
export function describeProjectAccess(
  isAdmin: boolean,
  isCreator: boolean,
  hasGrant: boolean,
): ProjectAccessDescription {
  if (isAdmin) {
    return { hasAccess: true, source: 'admin', revocable: false };
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
 * rather than reading the admin flag itself.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every account in the deployment with their standing on this project.
   *
   * The whole directory, not only the granted rows: the panel's question is "who
   * can open this", and an admin missing from the list while being able to open it
   * would read as a bug in the panel rather than as the flag working. With one
   * flat space there is no membership list to narrow it to.
   */
  async listMembers(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId, { includeArchived: true, requireAdmin: true });

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
        region: users.region,
        isAdmin: users.isAdmin,
      })
      .from(users)
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
        member.isAdmin,
        project?.createdByUserId === member.userId,
        granted.has(member.userId),
      ),
    }));
  }

  /** Give an account access to this project. Idempotent. */
  async grant(user: AuthenticatedUser, projectId: string, dto: GrantProjectAccessDto) {
    await this.authz.requireProjectAccess(user, projectId, {
      includeArchived: true,
      requireAdmin: true,
    });

    await this.assertAccountExists(dto.userId);

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
      projectId,
      userId: user.userId,
      metadata: { grantedUserId: dto.userId },
    });

    return { granted: true };
  }

  /** Withdraw a grant. Leaves access that comes from the admin flag or authorship alone. */
  async revoke(user: AuthenticatedUser, projectId: string, memberUserId: string) {
    await this.authz.requireProjectAccess(user, projectId, {
      includeArchived: true,
      requireAdmin: true,
    });

    await this.database.db
      .delete(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, memberUserId)),
      );

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_REVOKED,
      projectId,
      userId: user.userId,
      metadata: { revokedUserId: memberUserId },
    });

    return { revoked: true };
  }

  /**
   * Ask for access to a project you cannot open.
   *
   * Deliberately not resolveable through requireProjectAccess: a person who could
   * already open the project has nothing to ask for, and a person who cannot must
   * still be able to ask. What gates it instead is the region boundary — you may
   * ask about a project in your own region, or any project if you are an admin,
   * which is the same set of projects the list shows you.
   */
  async request(user: AuthenticatedUser, projectId: string, dto: RequestProjectAccessDto) {
    const [project] = await this.database.db
      .select({ id: projects.id, region: projects.region })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (!user.isAdmin && project.region !== user.region) {
      throw new BadRequestException(
        'That project is in another region. You can request access to projects in your own region.',
      );
    }

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
      projectId,
      userId: user.userId,
      metadata: { requestId: row.id },
    });

    return row;
  }

  /**
   * Every pending request, across every project.
   *
   * Admin-only and unfiltered. Region does not narrow it here: an admin sees all
   * regions by definition, and a queue that silently hid another region's asks
   * would be a queue with an invisible backlog.
   */
  async listPending(user: AuthenticatedUser) {
    await this.authz.requireAdmin(user);

    return this.database.db
      .select({
        id: projectAccessRequests.id,
        projectId: projectAccessRequests.projectId,
        projectName: projects.name,
        projectRegion: projects.region,
        userId: projectAccessRequests.userId,
        userName: users.name,
        userEmail: users.email,
        reason: projectAccessRequests.reason,
        createdAt: projectAccessRequests.createdAt,
      })
      .from(projectAccessRequests)
      .innerJoin(projects, eq(projects.id, projectAccessRequests.projectId))
      .innerJoin(users, eq(users.id, projectAccessRequests.userId))
      .where(eq(projectAccessRequests.status, 'pending'))
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
    await this.authz.requireProjectAccess(user, projectId, {
      includeArchived: true,
      requireAdmin: true,
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
      projectId,
      userId: user.userId,
      metadata: { requestId, decision: dto.decision, requesterUserId: request.userId },
    });

    return { decision: dto.decision };
  }

  /**
   * Refuses to grant to an account that does not exist.
   *
   * Kept even though there is no membership to check any more: the insert would
   * otherwise fail on the foreign key with a message about a constraint, which
   * reads like a platform fault rather than a bad user id.
   */
  private async assertAccountExists(userId: string): Promise<void> {
    const [account] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!account) {
      throw new BadRequestException('That account does not exist.');
    }
  }
}
