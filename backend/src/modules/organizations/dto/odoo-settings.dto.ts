import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The organisation's Odoo paths (ADR-033).
 *
 * Every field is optional and a blank string clears it, so the form can be
 * submitted with one field filled without wiping the others being an accident —
 * the service treats an omitted field and an empty one alike, which is what a
 * PUT of the whole settings object should do.
 *
 * Absoluteness and existence are checked in the service rather than here: the
 * service is where the filesystem is, and one rule in one place is better than
 * two that can disagree.
 */
export class UpdateOdooSettingsDto {
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
  projectsRoot?: string;
}
