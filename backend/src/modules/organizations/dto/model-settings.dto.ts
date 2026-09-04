import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MODEL_PROVIDER_IDS, type ModelProviderId } from '../../../core/enums';

/**
 * One provider row (ADR-023, extended to a list).
 *
 * `apiKey` is write-only. It is accepted here and never returned by any endpoint,
 * which is why there is no corresponding field on the response shape: the way to
 * guarantee a secret does not reach the frontend is for the response to have
 * nowhere to put one.
 */
export class AddModelProviderDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsBoolean()
  structuredOutputs?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Same fields as `AddModelProviderDto`, all optional: unset fields keep their stored value. */
export class UpdateModelProviderDto {
  @IsOptional()
  @IsIn(MODEL_PROVIDER_IDS, {
    message: `providerId must be one of: ${MODEL_PROVIDER_IDS.join(', ')}`,
  })
  providerId?: ModelProviderId;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsBoolean()
  structuredOutputs?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** The new priority order, as row ids from first to last. */
export class ReorderModelProvidersDto {
  @IsArray()
  @IsUUID('4', { each: true })
  order!: string[];
}

/**
 * Asks a server-side fetch for the model names an endpoint serves.
 *
 * `apiKey` here is the same write-only rule as everywhere else: sent up to
 * authenticate the discovery call, never echoed back.
 */
export class DiscoverModelsDto {
  @IsString()
  @MaxLength(500)
  baseUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  apiKey?: string;
}
