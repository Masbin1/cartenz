import type { UserRegion } from '../enums';

/**
 * The identity of the caller, as resolved from a verified access token.
 *
 * This is the only representation of "who is calling" in the application.
 * Controllers receive it through the CurrentUser decorator and pass it to the
 * authorisation service; they never read a token or a header themselves.
 */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  /**
   * The region the account works in (ADR-044). Carried on the token because it
   * is an attribute of the person, not of any one project, and every project
   * list needs it on every page load.
   */
  readonly region: UserRegion;
  /**
   * Whether the account is an admin. Also on the token: it gates whole route
   * groups (settings, user management) where a database read per request would
   * buy nothing, the same reasoning the region carries.
   */
  readonly isAdmin: boolean;
}

/** Claims carried by an access token. Kept minimal: no roles, no permissions. */
export interface AccessTokenClaims {
  /** Subject: the user id. */
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly region: UserRegion;
  readonly isAdmin: boolean;
  readonly type: 'access';
}

/**
 * Refresh tokens carry no region or admin flag: they are exchanged for a fresh
 * access token, and that exchange re-reads the account. A flag demoted in the
 * meantime therefore takes effect at the next refresh rather than at the next
 * token expiry.
 */
export interface RefreshTokenClaims {
  readonly sub: string;
  readonly jti: string;
  readonly type: 'refresh';
}
