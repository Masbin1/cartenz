import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { CurrentUser, clientIp } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { DatabaseService } from '../../core/database/database.service';
import { users } from '../../core/database/schema';
import { USER_REGIONS, type UserRegion } from '../../core/enums';
import { PasswordService } from './password.service';
import { AuthService } from './auth.service';
import { UserLinksService } from './user-links.service';
import { OrganizationService } from '../settings/organization.service';
import { randomBytes } from 'node:crypto';
import { ResetPasswordDto } from './dto/auth.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** What an admin may change about another account (ADR-044). */
class UpdateUserDto {
  @IsOptional()
  @IsIn(USER_REGIONS, { message: 'Choose one of the supported regions' })
  region?: UserRegion;

  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'A name is required' })
  @MaxLength(200)
  @Transform(trim)
  name?: string;
}

/** An account created by an admin rather than through self-registration. */
class CreateUserDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(320)
  @Transform(trimLower)
  email!: string;

  @IsString()
  @IsNotEmpty({ message: 'A name is required' })
  @MaxLength(200)
  @Transform(trim)
  name!: string;

  @IsIn(USER_REGIONS, { message: 'Choose one of the supported regions' })
  region!: UserRegion;

  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;
}

/**
 * /api/v1/users — the account directory.
 *
 * Every account is visible to every signed-in person. That is deliberate: with
 * one flat space, "who else is here" is not a secret, and a person who cannot
 * see the directory cannot tell whether the account they expect was ever created
 * — which is exactly the confusion the organisation model produced.
 *
 * Only an admin may create accounts, change them, or delete them. The exception
 * is self-registration from an allowed domain (ADR-072 addendum 2).
 */
@Controller('users')
export class MeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly links: UserLinksService,
    private readonly organization: OrganizationService,
  ) {}

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return {
      id: user.userId,
      email: user.email,
      name: user.name,
      region: user.region,
      isAdmin: user.isAdmin,
    };
  }

  @Get()
  async list() {
    return this.database.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        region: users.region,
        isAdmin: users.isAdmin,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.name));
  }

  /**
   * Admin provisioned account, by invitation (ADR-072). The account starts with
   * a random password nobody knows; the owner chooses theirs from the link,
   * which is mailed when mail is on and returned here either way.
   */
  @Post()
  async create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateUserDto) {
    await this.authz.requireAdmin(actor);
    await this.organization.requireAllowedEmail(dto.email);

    const [existing] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${dto.email.toLowerCase()}`)
      .limit(1);

    if (existing) {
      throw new ConflictException('An account already exists for this email address.');
    }

    const [created] = await this.database.db
      .insert(users)
      .values({
        email: dto.email,
        name: dto.name,
        passwordHash: await this.passwords.hash(randomBytes(32).toString('base64url')),
        region: dto.region,
        isAdmin: dto.isAdmin ?? false,
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        region: users.region,
        isAdmin: users.isAdmin,
        isActive: users.isActive,
        createdAt: users.createdAt,
      });

    await this.audit.record({
      event: AUDIT_EVENTS.USER_CREATED,
      userId: actor.userId,
      metadata: { createdUserId: created.id, email: created.email, isAdmin: created.isAdmin },
    });

    const invitation = await this.links.issue(created, 'invite');
    await this.audit.record({
      event: AUDIT_EVENTS.USER_INVITED,
      userId: actor.userId,
      metadata: { targetUserId: created.id, mailed: invitation.mailed },
    });

    return { ...created, invitation };
  }

  /**
   * Issues a fresh link for an account: an invitation for someone who never set
   * a password, a reset otherwise. Earlier unused links of that kind stop
   * working. The link is returned so the admin can hand it over directly.
   */
  @Post(':userId/link')
  @HttpCode(HttpStatus.OK)
  async issueLink(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: { purpose?: string },
  ) {
    await this.authz.requireAdmin(actor);
    const purpose = body?.purpose === 'reset' ? 'reset' : 'invite';
    const [target] = await this.database.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) throw new NotFoundException('Account not found');

    const link = await this.links.issue(target, purpose);
    await this.audit.record({
      event: AUDIT_EVENTS.USER_INVITED,
      userId: actor.userId,
      metadata: { targetUserId: target.id, purpose, mailed: link.mailed },
    });
    return link;
  }

  @Patch(':userId')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    await this.authz.requireAdmin(actor);

    const target = await this.assertAccountExists(userId);

    const removingAdmin = dto.isAdmin === false && target.isAdmin;
    const removingActive = dto.isActive === false && target.isActive;
    if (removingAdmin || removingActive) {
      await this.assertNotLastActiveAdmin(userId, target);
    }

    await this.database.db
      .update(users)
      .set({
        ...(dto.region === undefined ? {} : { region: dto.region }),
        ...(dto.isAdmin === undefined ? {} : { isAdmin: dto.isAdmin }),
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
        ...(dto.name === undefined ? {} : { name: dto.name }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await this.audit.record({
      event: AUDIT_EVENTS.USER_UPDATED,
      userId: actor.userId,
      metadata: {
        targetUserId: userId,
        region: dto.region,
        isAdmin: dto.isAdmin,
        isActive: dto.isActive,
        name: dto.name,
      },
    });

    const [row] = await this.database.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        region: users.region,
        isAdmin: users.isAdmin,
        isActive: users.isActive,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row;
  }

  /**
   * Sets another account's password (ADR-044).
   *
   * The manual stand-in for an email reset: an admin sets it here and hands the
   * value over out of band. Deliberately not a PATCH on the account: a password
   * is not an attribute alongside a region, and folding it into the same call
   * would mean a form that edits a region could carry a credential by accident.
   */
  @Post(':userId/reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: ResetPasswordDto,
    @Req() request: Request,
  ): Promise<{ reset: true }> {
    await this.authz.requireAdmin(actor);
    return this.auth.resetPassword(
      { userId: actor.userId, isAdmin: actor.isAdmin },
      userId,
      dto,
      clientIp(request),
    );
  }

  @Delete(':userId')
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
  ): Promise<{ deleted: true }> {
    await this.authz.requireAdmin(actor);

    if (actor.userId === userId) {
      throw new BadRequestException(
        'You cannot delete your own account. Ask another administrator to do it.',
      );
    }

    const target = await this.assertAccountExists(userId);
    await this.assertNotLastActiveAdmin(userId, target);

    await this.database.db.delete(users).where(eq(users.id, userId));

    await this.audit.record({
      event: AUDIT_EVENTS.USER_DELETED,
      userId: actor.userId,
      metadata: { deletedUserId: userId, email: target.email },
    });

    return { deleted: true };
  }

  /** Refuses to act on an account that does not exist. */
  private async assertAccountExists(userId: string) {
    const [account] = await this.database.db
      .select({
        id: users.id,
        email: users.email,
        isAdmin: users.isAdmin,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    return account;
  }

  /**
   * A deployment with no active administrator cannot be managed: nobody can
   * approve, grant or configure. Removing the last one - by demotion,
   * deactivation or deletion - is therefore refused.
   */
  private async assertNotLastActiveAdmin(
    targetUserId: string,
    target: { isAdmin: boolean; isActive: boolean },
  ): Promise<void> {
    if (!target.isAdmin || !target.isActive) return;

    const [{ total }] = await this.database.db
      .select({ total: count() })
      .from(users)
      .where(and(eq(users.isAdmin, true), eq(users.isActive, true), ne(users.id, targetUserId)));

    if (total === 0) {
      throw new BadRequestException(
        'That is the last active administrator. Promote another account first.',
      );
    }
  }
}
