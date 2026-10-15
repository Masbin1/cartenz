import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, scryptSync } from 'node:crypto';
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
import { UserLinksService } from './user-links.service';
import { OrganizationService, emailDomain } from '../settings/organization.service';
import type {
  AuthTokensResponse,
  ChangePasswordDto,
  LoginChallengeResponse,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto/auth.dto';

/**
 * Registration, sign-in, refresh and sign-out.
 *
 * Registration creates the user in the region they chose. The first account
 * becomes admin with the password it typed — with no organisation owner to
 * inherit the role, somebody has to be able to manage the deployment
 * (ADR-044) — and its domain becomes the first allowed one. Everyone after
 * registers only from an allowed domain and only through a link mailed to the
 * address, which is how the inbox is proved to exist (ADR-072 addendum 2).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly links: UserLinksService,
    private readonly organization: OrganizationService,
  ) {}

  /** True while no account exists: the next registration is the first admin. */
  async firstAccount(): Promise<boolean> {
    const [{ total }] = await this.database.db.select({ total: count() }).from(users);
    return total === 0;
  }

  /**
   * Registration after the first account. Answers the same whether or not the
   * address is taken, so the form cannot reveal who has an account; a link goes
   * out only for a new or still-unverified address. The account it creates has
   * a password nobody knows and cannot sign in until the link is used.
   */
  async registerByEmail(dto: RegisterDto, ipAddress: string | null): Promise<{ pending: true }> {
    await this.organization.requireAllowedEmail(dto.email);
    if (!(await this.links.mailEnabled())) {
      throw new ForbiddenException(
        'Sign-up needs email to confirm the address, and mail is not set up. Ask an administrator for an invitation.',
      );
    }

    const [existing] = await this.database.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        verified: users.emailVerifiedAt,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${dto.email.toLowerCase()}`)
      .limit(1);

    if (existing) {
      if (!existing.verified) await this.links.issueUnlessRecent(existing, 'verify');
      return { pending: true };
    }

    const [created] = await this.database.db
      .insert(users)
      .values({
        email: dto.email,
        name: dto.name,
        passwordHash: await this.passwords.hash(randomBytes(32).toString('base64url')),
        region: dto.region,
      })
      .onConflictDoNothing()
      .returning({ id: users.id, email: users.email, name: users.name, region: users.region });
    // A concurrent registration of the same address won; its link is on the way.
    if (!created) return { pending: true };

    await this.audit.record({
      event: AUDIT_EVENTS.USER_REGISTERED,
      userId: created.id,
      ipAddress,
      metadata: { email: created.email, region: created.region, verified: false },
    });
    await this.links.issue(created, 'verify');
    return { pending: true };
  }

  async register(dto: RegisterDto, ipAddress: string | null): Promise<AuthTokensResponse | { pending: true }> {
    if (!(await this.firstAccount())) return this.registerByEmail(dto, ipAddress);
    if (!dto.password) throw new BadRequestException('The first account needs a password.');
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
      // A race with another first registration is lost here, not merged.
      const [{ total }] = await tx.select({ total: count() }).from(users);
      if (total > 0) {
        throw new ConflictException('This deployment already has its first account. Register again.');
      }
      const isAdmin = true;

      const [created] = await tx
        .insert(users)
        .values({
          email: dto.email,
          name: dto.name,
          passwordHash,
          region: dto.region,
          isAdmin,
          // Nobody could have sent them mail yet; the admin's address is trusted.
          emailVerifiedAt: new Date(),
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

    const { allowedDomains } = await this.organization.get();
    if (!allowedDomains.length) {
      await this.organization.update(created.id, { allowedDomains: [emailDomain(created.email)] });
    }

    await this.audit.record({
      event: AUDIT_EVENTS.USER_REGISTERED,
      userId: created.id,
      ipAddress,
      metadata: { email: created.email, region: created.region },
    });

    return this.buildResponse({ ...created, region: created.region as UserRegion });
  }

  /**
   * Sign-in, step one. A correct password from a browser that passed a code in
   * the last 30 days, with no password change since, opens a session. Any
   * other browser gets a mailed code to type (ADR-072 addendum 4). With mail
   * off the code is skipped and audited, so an outage never locks anyone out.
   */
  async login(dto: LoginDto, ipAddress: string | null): Promise<AuthTokensResponse | LoginChallengeResponse> {
    const [user] = await this.database.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        region: users.region,
        isAdmin: users.isAdmin,
        passwordHash: users.passwordHash,
        isActive: users.isActive,
        emailVerifiedAt: users.emailVerifiedAt,
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

    // Reached only with the right password, so it reveals nothing to a guesser.
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Confirm your email address first: open the link we sent you.');
    }

    if (!(await this.links.isTrusted(user.id, dto.deviceToken))) {
      if (await this.links.mailEnabled()) {
        const { challenge, mailed } = await this.links.startLogin(user);
        if (mailed) return { otpRequired: true, challenge };
      }
      await this.audit.record({
        event: AUDIT_EVENTS.USER_LOGIN_OTP_SKIPPED,
        userId: user.id,
        ipAddress,
        metadata: { reason: 'mail unavailable' },
      });
    }

    return this.openSession(user.id, ipAddress);
  }

  /** Sign-in, step two: the mailed code opens the session and trusts this browser. */
  async verifyLogin(challenge: string, code: string, ipAddress: string | null): Promise<AuthTokensResponse> {
    const userId = await this.links.completeLogin(challenge, code);
    const response = await this.openSession(userId, ipAddress);
    return { ...response, deviceToken: await this.links.trustDevice(userId) };
  }

  private async openSession(userId: string, ipAddress: string | null): Promise<AuthTokensResponse> {
    const [user] = await this.database.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        region: users.region,
        isAdmin: users.isAdmin,
        isActive: users.isActive,
      });
    // A deactivation between the password and the code wins.
    if (!user?.isActive) throw new UnauthorizedException('This account is no longer active.');

    await this.audit.record({
      event: AUDIT_EVENTS.USER_LOGGED_IN,
      userId: user.id,
      ipAddress,
      metadata: { email: user.email },
    });

    return this.buildResponse({ ...user, region: user.region as UserRegion });
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
