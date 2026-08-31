import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MODEL_PROVIDER_IDS, type ModelProviderId } from '../../../core/enums';

/**
 * The organisation's model provider configuration (ADR-023).
 *
 * `apiKey` is write-only. It is accepted here and never returned by any endpoint,
 * which is why there is no corresponding field on the response shape: the way to
 * guarantee a secret does not reach the frontend is for the response to have
 * nowhere to put one.
 */
export class WriteModelSettingsDto {
  @IsIn(MODEL_PROVIDER_IDS, {
    message: `providerId must be one of: ${MODEL_PROVIDER_IDS.join(', ')}`,
  })
  providerId!: ModelProviderId;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  /**
   * Checked for shape only. Whether the URL is acceptable - https, or http on
   * localhost - is decided by the service, so there is one authority rather than
   * two that can disagree.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  /**
   * Omit to keep the key already stored, which is what someone editing the model
   * name expects. Send an empty string to remove it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  apiKey?: string;
}
