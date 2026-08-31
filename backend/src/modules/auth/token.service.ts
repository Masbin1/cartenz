import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { refreshTokens } from '../../core/database/schema';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import type {
  AccessTokenClaims,
  RefreshTokenClaims,
} from '../../core/authz/authenticated-user';

/** Rotation outcome: a new pair, and the id of the record that was retired. */
export interface RotatedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
}

/**
 * Issues and rotates tokens (ADR-015).
 *
 * Access tokens are stateless and short-lived. Refresh tokens are persisted as a
 * SHA-256 hash, never as the value, and are single-use: presenting one both
 * revokes it and issues a replacement. A token presented twice is therefore
 * detectable, and is treated as compromise of the whole chain rather than as a
 * retryable error.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issuePair(user: { id: string; email: string; name: string }): Promise<RotatedTokens> {
    const accessToken = await this.signAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user.id);
    return { accessToken, refreshToken, userId: user.id };
  }

  async signAccessToken(user: { id: string; email: string; name: string }): Promise<string> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      name: user.name,
      type: 'access',
    };
    return this.jwt.signAsync(claims, { expiresIn: this.config.auth.accessTtl });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch {
      throw new UnauthorizedException('The access token is invalid or has expired.');
    }
    // A refresh token is also a valid signature under the same secret, so the
    // type claim must be checked or a refresh token would work as an access token.
    if (claims.type !== 'access') {
      throw new UnauthorizedException('The supplied token is not an access token.');
    }
    return claims;
  }

  private async issueRefreshToken(userId: string): Promise<string> {
    const jti = randomUUID();
    const claims: RefreshTokenClaims = { sub: userId, jti, type: 'refresh' };
    const token = await this.jwt.signAsync(claims, { expiresIn: this.config.auth.refreshTtl });

    await this.database.db.insert(refreshTokens).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt: this.refreshExpiry(),
    });

    return token;
  }

  /**
   * Consumes a refresh token and issues a replacement. Revocation and issuance
   * happen in one transaction, so a crash cannot leave a token both revoked and
   * unreplaced.
   */
  async rotate(presentedToken: string): Promise<{ userId: string; refreshToken: string }> {
    let claims: RefreshTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<RefreshTokenClaims>(presentedToken);
    } catch {
      throw new UnauthorizedException('The refresh token is invalid or has expired.');
    }
    if (claims.type !== 'refresh') {
      throw new UnauthorizedException('The supplied token is not a refresh token.');
    }

    const presentedHash = hashToken(presentedToken);

    return this.database.transaction(async (tx) => {
      const [record] = await tx
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.tokenHash, presentedHash), isNull(refreshTokens.revokedAt)))
        .limit(1);

      if (!record) {
        // Either never issued, or already spent. A replayed token means the
        // value has leaked, so every session for the subject is revoked.
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, claims.sub), isNull(refreshTokens.revokedAt)));
        throw new UnauthorizedException(
          'This refresh token has already been used. All sessions have been signed out.',
        );
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('The refresh token has expired.');
      }

      const jti = randomUUID();
      const replacement = await this.jwt.signAsync(
        { sub: claims.sub, jti, type: 'refresh' } satisfies RefreshTokenClaims,
        { expiresIn: this.config.auth.refreshTtl },
      );

      const [inserted] = await tx
        .insert(refreshTokens)
        .values({
          userId: claims.sub,
          tokenHash: hashToken(replacement),
          expiresAt: this.refreshExpiry(),
        })
        .returning({ id: refreshTokens.id });

      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), replacedById: inserted.id })
        .where(eq(refreshTokens.id, record.id));

      return { userId: claims.sub, refreshToken: replacement };
    });
  }

  /** Revokes a single refresh token. Used on sign-out. */
  async revoke(token: string): Promise<void> {
    await this.database.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.tokenHash, hashToken(token)), isNull(refreshTokens.revokedAt)));
  }

  /** Revokes every active refresh token for a user. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.database.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + durationToMs(this.config.auth.refreshTtl));
  }
}

/**
 * SHA-256 of the token. A refresh token is a 300-plus character random JWT, so
 * it is not subject to the offline guessing that makes a plain hash unsuitable
 * for passwords; the hash exists so a database disclosure does not yield usable
 * sessions.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Random opaque value, used where a token needs no claims. */
export function randomOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Converts a validated duration such as `30d` to milliseconds. */
export function durationToMs(duration: string): number {
  const match = /^([0-9]+)(ms|s|m|h|d)$/.exec(duration);
  if (!match) {
    throw new Error(`Unsupported duration: ${duration}`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}
