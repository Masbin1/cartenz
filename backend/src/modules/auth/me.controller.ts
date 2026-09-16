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
  MinLength,
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
  @MinLength(12, { message: 'The password must be at least 12 characters' })
  @MaxLength(256)
  password!: string;

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
 * is self-registration, which stays open.
 */
@Controller('users')
export class MeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
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

  /** Admin provisioned account. Issues no tokens: the owner signs in themselves. */
  @Post()
  async create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateUserDto) {
    await this.authz.requireAdmin(actor);

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
        passwordHash: await this.passwords.hash(dto.password),
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

    return created;
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
