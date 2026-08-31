import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { organizationMembers, organizations, users } from '../../core/database/schema';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { ROLE_RANK, type OrganizationRole } from '../../core/enums';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { allocateOrganizationSlug } from './slug';
import type { AddMemberDto, CreateOrganizationDto } from './dto/organization.dto';

/**
 * Organisations and their membership.
 *
 * Organisation isolation is the boundary the whole platform rests on, so every
 * method here resolves the caller's membership through AuthorizationService
 * before touching a row - including the read methods.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /** Organisations the caller belongs to. Never a global list. */
  async listForUser(user: AuthenticatedUser) {
    return this.database.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: organizationMembers.role,
        createdAt: organizations.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, user.userId))
      .orderBy(organizations.name);
  }

  async create(user: AuthenticatedUser, dto: CreateOrganizationDto) {
    const slug = await allocateOrganizationSlug(this.database, dto.name);

    const organization = await this.database.transaction(async (tx) => {
      const [created] = await tx
        .insert(organizations)
        .values({ name: dto.name, slug })
        .returning();

      await tx.insert(organizationMembers).values({
        organizationId: created.id,
        userId: user.userId,
        role: 'owner',
      });

      return created;
    });

    await this.audit.record({
      event: AUDIT_EVENTS.ORGANIZATION_CREATED,
      organizationId: organization.id,
      userId: user.userId,
      metadata: { name: organization.name, slug: organization.slug },
    });

    return { ...organization, role: 'owner' as OrganizationRole };
  }

  async findOne(user: AuthenticatedUser, organizationId: string) {
    const membership = await this.authz.requireOrganizationMember(user, organizationId);

    const [organization] = await this.database.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (!organization) throw new NotFoundException('Organisation not found');

    return { ...organization, role: membership.role };
  }

  async listMembers(user: AuthenticatedUser, organizationId: string) {
    await this.authz.requireOrganizationMember(user, organizationId);

    return this.database.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: organizationMembers.role,
        joinedAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, organizationId))
      .orderBy(users.name);
  }

  /**
   * Adds an existing user to an organisation.
   *
   * The invited person must already have an account: creating one here would
   * mean the platform issuing credentials on someone else's behalf, and account
   * creation belongs with the identity provider (ADR-015).
   */
  async addMember(user: AuthenticatedUser, organizationId: string, dto: AddMemberDto) {
    const membership = await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    this.assertMayGrantRole(membership.role, dto.role);

    const [invitee] = await this.database.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(sql`lower(${users.email}) = ${dto.email.toLowerCase()}`)
      .limit(1);

    if (!invitee) {
      throw new NotFoundException(
        'No account exists for that email address. The person must register before being added.',
      );
    }

    const [existing] = await this.database.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, invitee.id),
        ),
      )
      .limit(1);

    if (existing) {
      throw new ConflictException('That person is already a member of this organisation.');
    }

    await this.database.db.insert(organizationMembers).values({
      organizationId,
      userId: invitee.id,
      role: dto.role,
    });

    await this.audit.record({
      event: AUDIT_EVENTS.ORGANIZATION_MEMBER_ADDED,
      organizationId,
      userId: user.userId,
      metadata: { memberUserId: invitee.id, role: dto.role },
    });

    return { userId: invitee.id, email: invitee.email, name: invitee.name, role: dto.role };
  }

  async updateMemberRole(
    user: AuthenticatedUser,
    organizationId: string,
    memberUserId: string,
    role: OrganizationRole,
  ) {
    const membership = await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    this.assertMayGrantRole(membership.role, role);

    const [target] = await this.database.db
      .select({ id: organizationMembers.id, role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, memberUserId),
        ),
      )
      .limit(1);

    if (!target) throw new NotFoundException('That person is not a member of this organisation.');

    // Demoting an owner is only an owner's decision, and never the last owner's.
    if (target.role === 'owner') {
      if (membership.role !== 'owner') {
        throw new ForbiddenException('Only an owner may change another owner.');
      }
      if (role !== 'owner') {
        await this.assertNotLastOwner(organizationId, memberUserId);
      }
    }

    await this.database.db
      .update(organizationMembers)
      .set({ role, updatedAt: new Date() })
      .where(eq(organizationMembers.id, target.id));

    await this.audit.record({
      event: AUDIT_EVENTS.ORGANIZATION_MEMBER_ROLE_CHANGED,
      organizationId,
      userId: user.userId,
      metadata: { memberUserId, previousRole: target.role, role },
    });

    return { userId: memberUserId, role };
  }

  async removeMember(user: AuthenticatedUser, organizationId: string, memberUserId: string) {
    const membership = await this.authz.requireOrganizationMember(user, organizationId, 'admin');

    const [target] = await this.database.db
      .select({ id: organizationMembers.id, role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, memberUserId),
        ),
      )
      .limit(1);

    if (!target) throw new NotFoundException('That person is not a member of this organisation.');

    if (target.role === 'owner') {
      if (membership.role !== 'owner') {
        throw new ForbiddenException('Only an owner may remove another owner.');
      }
      await this.assertNotLastOwner(organizationId, memberUserId);
    }

    await this.database.db
      .delete(organizationMembers)
      .where(eq(organizationMembers.id, target.id));

    await this.audit.record({
      event: AUDIT_EVENTS.ORGANIZATION_MEMBER_REMOVED,
      organizationId,
      userId: user.userId,
      metadata: { memberUserId, previousRole: target.role },
    });
  }

  /**
   * An admin may not grant a role above their own. Without this, an admin could
   * grant ownership and then be promoted by the account they just created.
   */
  private assertMayGrantRole(actorRole: OrganizationRole, grantedRole: OrganizationRole): void {
    if (ROLE_RANK[grantedRole] > ROLE_RANK[actorRole]) {
      throw new ForbiddenException(
        `You may not grant the ${grantedRole} role, which is above your own ${actorRole} role.`,
      );
    }
  }

  /** An organisation must always retain at least one owner. */
  private async assertNotLastOwner(organizationId: string, ownerUserId: string): Promise<void> {
    const [count] = await this.database.db
      .select({ owners: sql<number>`count(*)::int` })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.role, 'owner'),
        ),
      );

    if ((count?.owners ?? 0) <= 1) {
      throw new BadRequestException(
        'This is the only owner of the organisation. Appoint another owner first.',
      );
    }
    // Referenced so that the signature documents whose removal is being checked.
    void ownerUserId;
  }
}
