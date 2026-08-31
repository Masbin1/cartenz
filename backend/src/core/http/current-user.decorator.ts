import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../authz/authenticated-user';

/** Key under which JwtAuthGuard attaches the resolved identity. */
export const AUTH_USER_KEY = 'linkederpUser';

export interface AuthenticatedRequest extends Request {
  [AUTH_USER_KEY]?: AuthenticatedUser;
}

/**
 * Supplies the authenticated caller to a controller method.
 *
 * The guard has already run, so the value is present. The non-null assertion is
 * the one place this is asserted; if the decorator were used on an unguarded
 * route the request would fail here rather than silently proceeding with an
 * undefined user.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request[AUTH_USER_KEY];
    if (!user) {
      throw new Error(
        'CurrentUser was used on a route that is not protected by JwtAuthGuard.',
      );
    }
    return user;
  },
);

/** Client IP for the audit trail. Trusts the proxy header only when set. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return request.ip ?? null;
}
