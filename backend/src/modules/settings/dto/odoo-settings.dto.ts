import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * The deployment's Odoo paths (ADR-033, ADR-044).
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

/**
 * Outgoing mail and the portal URL (ADR-072 addendum). Every field optional: an
 * omitted field keeps its stored value. `smtpPassword` omitted keeps the stored
 * password; an empty string removes it.
 */
export class UpdateMailSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(253)
  smtpHost?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  smtpPort?: number | null;

  @IsOptional()
  @IsBoolean()
  smtpSecure?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  smtpUser?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  smtpPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  mailFrom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  portalUrl?: string;
}
