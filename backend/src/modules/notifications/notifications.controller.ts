import { Body, Controller, Delete, Get, Headers, HttpCode, Post, Put } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import {
  SubscribePushDto,
  UnsubscribePushDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';

/**
 * Push notification endpoints (ADR-065).
 *
 * Every route is scoped to the caller: a subscription belongs to the browser
 * that registered it, and the caller's own id is what it is stored under. There
 * is no route that lists another person's subscriptions, and the one that
 * deletes is filtered by `user_id` as well as `endpoint`.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * What the portal needs before it can ask the browser for permission: whether
   * the deployment has keys at all, and the public key the browser subscribes
   * with.
   */
  @Get('config')
  config() {
    return {
      enabled: this.notifications.isEnabled,
      publicKey: this.notifications.publicKey || null,
    };
  }

  @Get('preferences')
  preferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.preferences(user.userId);
  }

  @Put('preferences')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(user.userId, dto);
  }

  /** How many browsers this account is registered on, for the account page. */
  @Get('subscriptions')
  async subscriptions(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.notifications.subscriptionCount(user.userId) };
  }

  @Post('subscriptions')
  @HttpCode(204)
  async subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubscribePushDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.notifications.subscribe(user.userId, dto, userAgent ?? null);
  }

  @Delete('subscriptions')
  @HttpCode(204)
  async unsubscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UnsubscribePushDto,
  ): Promise<void> {
    await this.notifications.unsubscribe(user.userId, dto);
  }

  @Post('test')
  @HttpCode(200)
  test(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.sendTest(user.userId);
  }
}
