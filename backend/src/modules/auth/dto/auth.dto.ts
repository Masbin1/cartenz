import { IsEmail, IsIn, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { USER_REGIONS, type UserRegion } from '../../../core/enums';

/**
 * Request shapes for the authentication endpoints.
 *
 * API schemas are kept separate from the database rows they eventually write, so
 * that a column can be added without becoming accepted input, and so that
 * validation lives at the boundary rather than in a service.
 */

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
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

  /**
   * The region the account works in (ADR-044). Required: it is the access
   * boundary, so an account without one would see nothing or everything
   * depending on how the filter happened to be written.
   */
  @IsIn(USER_REGIONS, { message: 'Choose one of the supported regions' })
  region!: UserRegion;
}

export class LoginDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(trimLower)
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

/**
 * Changing your own password.
 *
 * The current password is required even though the caller is already
 * authenticated: a token is something a borrowed laptop also has, and the
 * password is the one thing only the account holder knows.
 */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Your current password is required' })
  currentPassword!: string;

  @IsString()
  @MinLength(12, { message: 'The new password must be at least 12 characters' })
  @MaxLength(256)
  newPassword!: string;
}

/**
 * An admin setting someone else's password.
 *
 * No current password: the point of this route is that nobody knows it. What
 * stands in its place is the admin check and the audit entry.
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(12, { message: 'The new password must be at least 12 characters' })
  @MaxLength(256)
  newPassword!: string;
}

/** Response shape. Declared explicitly so no row field leaks by accident. */
export interface AuthTokensResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly region: UserRegion;
    readonly isAdmin: boolean;
  };
}
