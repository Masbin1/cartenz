import { IsBoolean, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** The two keys `PushSubscription.toJSON().keys` returns. */
class PushSubscriptionKeysDto {
  @IsString()
  p256dh!: string;

  @IsString()
  auth!: string;
}

/**
 * The shape `PushSubscription.toJSON()` produces in the browser, passed
 * through unchanged. `endpoint` is validated as a URL because it is dereferenced
 * by the push library on every send; anything else is rejected before it is
 * stored.
 */
export class SubscribePushDto {
  @IsUrl({ require_protocol: true })
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;
}

export class UnsubscribePushDto {
  @IsUrl({ require_protocol: true })
  endpoint!: string;
}

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  approvalRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  taskCompleted?: boolean;

  @IsOptional()
  @IsBoolean()
  taskFailed?: boolean;

  @IsOptional()
  @IsBoolean()
  soundEnabled?: boolean;
}

export interface NotificationPreferencesResponse {
  readonly approvalRequired: boolean;
  readonly taskCompleted: boolean;
  readonly taskFailed: boolean;
  readonly soundEnabled: boolean;
}
