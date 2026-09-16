import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { scryptSync } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { users } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import type { UserRegion } from '../../core/enums';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import type {
  AuthTokensResponse,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto/auth.dto';

/**
 * Registration, sign-in, refresh and sign-out.
 *
 * Registration creates the user in the region they chose. The first account
 * registered becomes admin — with no organisation owner to inherit the role,
 * somebody has to be able to manage the deployment (ADR-044).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async register(dto: RegisterDto, ipAddress: string | null): Promise<AuthTokensResponse> {
    const passwordHash = await this.passwords.hash(dto.password);

    const created = await this.database.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${dto.email.toLowerCase()}`)
        .limit(1);

      if (existing) {
        throw new ConflictException('An account already exists for this email address.');
      }

      // First account is admin, so a fresh deployment is never unmanageable.
      const [{ total }] = await tx.select({ total: count() }).from(users);
      const isAdmin = total === 0;

      const [created] = await tx
        .insert(users)
        .values({
          email: dto.email,
          name: dto.name,
          passwordHash,
          region: dto.region,
          isAdmin,
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          region: users.region,
          isAdmin: users.isAdmin,
        });

      return created;
    });

    await this.audit.record({
      event: AUDIT_EVENTS.USER_REGISTERED,
      userId: created.id,
      ipAddress,
      metadata: { email: created.email, region: created.region },
    });

    return this.buildResponse({ ...created, region: created.region as UserRegion });
  }

  async login(dto: LoginDto, ipAddress: string | null): Promise<AuthTokensResponse> {
    const [user] = await this.database.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        region: users.region,
        isAdmin: users.isAdmin,
        passwordHash: users.passwordHash,
        isActive: users.isActive,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${dto.email.toLowerCase()}`)
      .limit(1);

    /**
     * A password verification runs even when no account exists, against a hash
     * of a fixed value. Without it, the response time would tell an attacker
     * which addresses are registered.
     */
    const storedHash = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await this.passwords.verify(dto.password, storedHash);

    if (!user || !passwordMatches || !user.isActive) {
      await this.audit.record({
        event: AUDIT_EVENTS.USER_LOGIN_FAILED,
        userId: user?.id ?? null,
        ipAddress,
        metadata: {
          email: dto.email,
          reason: !user ? 'no such account' : !passwordMatches ? 'password mismatch' : 'inactive',
        },
      });
      throw new UnauthorizedException('The email address or password is incorrect.');
    }

    await this.database.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    await this.audit.record({
      event: AUDIT_EVENTS.USER_LOGGED_IN,
      userId: user.id,
      ipAddress,
      metadata: { email: user.email },
    });

    return this.buildResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      region: user.region as UserRegion,
      isAdmin: user.isAdmin,
    });
  }

  async refresh(refreshToken: string, ipAddress: string | null): Promise<AuthTokensResponse> {
    const rotated = await this.tokens.rotate(refreshToken);

    const [user] = await this.database.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        region: users.region,
        isAdmin: users.isAdmin,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, rotated.userId))
      .limit(1);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('This account is no longer active.');
    }

    await this.audit.record({
      event: AUDIT_EVENTS.USER_TOKEN_REFRESHED,
      userId: user.id,
      ipAddress,
    });

    return {
      accessToken: await this.tokens.signAccessToken({ ...user, region: user.region as UserRegion }),
      refreshToken: rotated.refreshToken,
      expiresIn: this.config.auth.accessTtl,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        region: user.region as UserRegion,
        isAdmin: user.isAdmin,
      },
    };
  }

  /**
   * Changes the caller's own password.
   *
   * Every other session is revoked on success. That is the point of the
   * operation as often as not: a password is changed because it may be known to
   * somebody else, and leaving their session alive would defeat the change.
   * The caller keeps their own tokens, so the screen they are on does not
   * suddenly sign them out.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    ipAddress: string | null,
  ): Promise<{ changed: true }> {
    const [user] = await this.database.db
      .select({ id: users.id, passwordHash: users.passwordHash, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('This account is no longer active.');
    }

    const matches = await this.passwords.verify(dto.currentPassword, user.passwordHash);
    if (!matches) {
      await this.audit.record({
        event: AUDIT_EVENTS.USER_LOGIN_FAILED,
        userId,
        ipAddress,
        metadata: { reason: 'current password mismatch on change' },
      });
      throw new UnauthorizedException('Your current password is incorrect.');
    }

    // Refused here rather than accepted silently: a "change" that changes
    // nothing reads as done, and the person walks away believing it was.
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('The new password must differ from the current one.');
    }

    await this.database.db
      .update(users)
      .set({ passwordHash: await this.passwords.hash(dto.newPassword), updatedAt: new Date() })
      .where(eq(users.id, userId));

    await this.tokens.revokeAllForUser(userId);

    await this.audit.record({
      event: AUDIT_EVENTS.USER_PASSWORD_CHANGED,
      userId,
      ipAddress,
      metadata: { self: true },
    });

    return { changed: true };
  }

  /**
   * Sets another account's password, without knowing the old one (ADR-044).
   *
   * The manual stand-in for an email reset flow: an admin sets a password and
   * hands it over out of band. Every session belonging to the target is revoked,
   * because the person who had the old credential must not keep a live session.
   */
  async resetPassword(
    actor: { userId: string; isAdmin: boolean },
    targetUserId: string,
    dto: ResetPasswordDto,
    ipAddress: string | null,
  ): Promise<{ reset: true }> {
    const [target] = await this.database.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!target) {
      throw new NotFoundException('Account not found');
    }

    await this.database.db
      .update(users)
      .set({ passwordHash: await this.passwords.hash(dto.newPassword), updatedAt: new Date() })
      .where(eq(users.id, targetUserId));

    await this.tokens.revokeAllForUser(targetUserId);

    await this.audit.record({
      event: AUDIT_EVENTS.USER_PASSWORD_RESET,
      userId: actor.userId,
      ipAddress,
      metadata: { targetUserId, targetEmail: target.email },
    });

    return { reset: true };
  }

  async logout(userId: string, refreshToken: string | undefined): Promise<void> {
    if (refreshToken) {
      await this.tokens.revoke(refreshToken);
    } else {
      await this.tokens.revokeAllForUser(userId);
    }
    await this.audit.record({ event: AUDIT_EVENTS.USER_LOGGED_OUT, userId });
  }

  private async buildResponse(user: {
    id: string;
    email: string;
    name: string;
    region: UserRegion;
    isAdmin: boolean;
  }): Promise<AuthTokensResponse> {
    const pair = await this.tokens.issuePair(user);
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: this.config.auth.accessTtl,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        region: user.region,
        isAdmin: user.isAdmin,
      },
    };
  }
}

/**
 * A valid scrypt hash of a value no account uses. Derived once at module load so
 * that it is guaranteed well-formed, and only ever compared against, to equalise
 * the cost of a failed and a successful sign-in.
 */
const DUMMY_HASH = buildDummyHash();

function buildDummyHash(): string {
  const salt = Buffer.alloc(16, 0);
  const derived = scryptSync('linkederp-timing-equaliser', salt, 64, { N: 16384, r: 8, p: 1 });
  return ['scrypt', '1', '16384', '8', '1', salt.toString('base64'), derived.toString('base64')].join(
    '$',
  );
}
