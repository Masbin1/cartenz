import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CREDENTIAL_KINDS, type CredentialKind } from '../../../core/enums';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateGitCredentialDto {
  @IsString()
  @IsNotEmpty({ message: 'A label is required' })
  @MaxLength(120)
  @Transform(trim)
  label!: string;

  /**
   * The private key (for ssh_key) or the personal access token (for token).
   * Required when creating; write-only across the API boundary.
   */
  @IsString()
  @IsNotEmpty({ message: 'A credential value is required' })
  @MaxLength(16384)
  value!: string;

  @IsOptional()
  @IsIn(CREDENTIAL_KINDS, {
    message: `credentialKind must be one of: ${CREDENTIAL_KINDS.join(', ')}`,
  })
  credentialKind?: CredentialKind;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hosts?: string[];

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export class UpdateGitCredentialDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  label?: string;

  /** Omitted keeps the current stored value. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(16384)
  value?: string;

  @IsOptional()
  @IsIn(CREDENTIAL_KINDS, {
    message: `credentialKind must be one of: ${CREDENTIAL_KINDS.join(', ')}`,
  })
  credentialKind?: CredentialKind;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hosts?: string[];

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export class TestGitCredentialDto {
  /**
   * A repository URL to test the credential against (e.g.
   * `git@github.com:org/repo.git`). Uses `git ls-remote` without cloning.
   */
  @IsString()
  @IsNotEmpty({ message: 'A repository URL is required to test against' })
  @MaxLength(2048)
  @Transform(trim)
  repositoryUrl!: string;
}
