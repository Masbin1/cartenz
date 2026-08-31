import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { scryptSync } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { organizationMembers, organizations, users } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import type { AuthTokensResponse, LoginDto, RegisterDto } from './dto/auth.dto';
import { allocateOrganizationSlug } from '../organizations/slug';

/**
 * Registration, sign-in, refresh and sign-out.
 *
 * Registration creates the user and, where an organisation name is supplied, the
 * organisation with the user as its owner - in one transaction, so a failure
 * cannot leave a user with no organisation and therefore nowhere to work.
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

    /**
     * The slug is allocated before the transaction opens: it needs its own
     * read-then-write loop, and the unique index is what actually guarantees
     * uniqueness if two registrations race.
     */
    const organizationSlug =
      dto.organizationName && dto.organizationName.length > 0
        ? await allocateOrganizationSlug(this.database, dto.organizationName)
        : null;

    const created = await this.database.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${dto.email.toLowerCase()}`)
        .limit(1);

      if (existing) {
        throw new ConflictException('An account already exists for this email address.');
      }

      const [user] = await tx
        .insert(users)
        .values({ email: dto.email, name: dto.name, passwordHash })
        .returning({ id: users.id, email: users.email, name: users.name });

      let organizationId: string | null = null;
      if (organizationSlug && dto.organizationName) {
        const [organization] = await tx
          .insert(organizations)
          .values({
            name: dto.organizationName,
            slug: organizationSlug,
          })
          .returning({ id: organizations.id });

        await tx.insert(organizationMembers).values({
          organizationId: organization.id,
          userId: user.id,
          role: 'owner',
        });
        organizationId = organization.id;
      }

      return { user, organizationId };
    });

    await this.audit.record({
      event: AUDIT_EVENTS.USER_REGISTERED,
      userId: created.user.id,
      organizationId: created.organizationId,
      ipAddress,
      metadata: { email: created.user.email, createdOrganization: created.organizationId !== null },
    });

    if (created.organizationId) {
      await this.audit.record({
        event: AUDIT_EVENTS.ORGANIZATION_CREATED,
        userId: created.user.id,
        organizationId: created.organizationId,
        ipAddress,
        metadata: { name: dto.organizationName, viaRegistration: true },
      });
    }

    return this.buildResponse(created.user);
  }

  async login(dto: LoginDto, ipAddress: string | null): Promise<AuthTokensResponse> {
    const [user] = await this.database.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
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

    return this.buildResponse({ id: user.id, email: user.email, name: user.name });
  }

  async refresh(refreshToken: string, ipAddress: string | null): Promise<AuthTokensResponse> {
    const rotated = await this.tokens.rotate(refreshToken);

    const [user] = await this.database.db
      .select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive })
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
      accessToken: await this.tokens.signAccessToken(user),
      refreshToken: rotated.refreshToken,
      expiresIn: this.config.auth.accessTtl,
      user: { id: user.id, email: user.email, name: user.name },
    };
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
  }): Promise<AuthTokensResponse> {
    const pair = await this.tokens.issuePair(user);
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: this.config.auth.accessTtl,
      user: { id: user.id, email: user.email, name: user.name },
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
