import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

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
   * Optional organisation name. Supplied on first registration to create the
   * organisation the user owns; omitted when joining an existing one.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  organizationName?: string;
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

/** Response shape. Declared explicitly so no row field leaks by accident. */
export interface AuthTokensResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
}
