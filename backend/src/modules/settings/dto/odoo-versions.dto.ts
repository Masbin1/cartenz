import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ODOO_EDITIONS, ODOO_VERSIONS, type OdooEdition, type OdooVersion } from '../../../core/enums';

/**
 * Registering a full Odoo source checkout for one version (ADR-045).
 *
 * Absoluteness and existence of the paths are checked in the service rather
 * than here: the service is where the filesystem is, and one rule in one place
 * is better than two that can disagree (the same split ADR-033 uses).
 */
export class CreateOdooVersionRepositoryDto {
  @IsIn(ODOO_VERSIONS, {
    message: `version must be one of: ${ODOO_VERSIONS.join(', ')}`,
  })
  version!: OdooVersion;

  @IsString()
  @MaxLength(500)
  basePath!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  enterprisePath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

/** All fields optional: an unset field keeps its stored value. */
export class UpdateOdooVersionRepositoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  basePath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  enterprisePath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** A project brief to recommend modules for (ADR-056 addendum). */
export class RecommendModulesDto {
  @IsString()
  @IsNotEmpty({ message: 'A project brief is required' })
  @MaxLength(4000)
  brief!: string;

  @IsIn(ODOO_EDITIONS, { message: `edition must be one of: ${ODOO_EDITIONS.join(', ')}` })
  edition!: OdooEdition;
}
