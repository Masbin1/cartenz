import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { TokenService } from './token.service';
import { DatabaseService } from '../../core/database/database.service';
import { users } from '../../core/database/schema';
import type { UserRegion } from '../../core/enums';
import { IS_PUBLIC_KEY } from '../../core/http/public.decorator';
import { AUTH_USER_KEY, AuthenticatedRequest } from '../../core/http/current-user.decorator';

/**
 * The single point at which identity enters the application (ADR-015).
 *
 * Applied globally, so authentication is the default and a route is open only
 * where it is explicitly marked @Public. Replacing this class with one that
 * validates Keycloak or Ory tokens is the whole of the migration to a
 * third-party identity provider.
 *
 * The user row is read on every request rather than trusted from the token, so
 * that deactivating an account — or changing its region or admin flag — takes
 * effect immediately instead of at the next token expiry. The token carries the
 * same two attributes, but only as a fallback for code that holds a claims
 * object rather than a request; this read is what authorises.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers?.authorization);
    if (!token) {
      throw new UnauthorizedException('An access token is required.');
    }

    const claims = await this.tokens.verifyAccessToken(token);

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
      .where(eq(users.id, claims.sub))
      .limit(1);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('This account is no longer active.');
    }

    request[AUTH_USER_KEY] = {
      userId: user.id,
      email: user.email,
      name: user.name,
      region: user.region as UserRegion,
      isAdmin: user.isAdmin,
    };
    return true;
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}
