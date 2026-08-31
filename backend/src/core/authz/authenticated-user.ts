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
}

/** Claims carried by an access token. Kept minimal: no roles, no permissions. */
export interface AccessTokenClaims {
  /** Subject: the user id. */
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly type: 'access';
}

/**
 * Roles are deliberately absent from the token. A token that carried an
 * organisation role would keep granting that role until it expired, so a
 * revoked or downgraded membership would remain effective. Membership is read
 * from the database on every authorisation decision instead.
 */
export interface RefreshTokenClaims {
  readonly sub: string;
  readonly jti: string;
  readonly type: 'refresh';
}
