import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import webpush from 'web-push';
import { DatabaseService } from '../../core/database/database.service';
import {
  agentTasks,
  notificationPreferences,
  projects,
  pushSubscriptions,
  users,
} from '../../core/database/schema';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import {
  buildPushPayload,
  isNotifyingEvent,
  type NotifyingEvent,
  type PushPayload,
} from './push-payload';
import type {
  NotificationPreferencesResponse,
  SubscribePushDto,
  UnsubscribePushDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';
import type { TaskEvent } from '../../core/events/event-types';

/** What a task event carries that the dispatcher needs, without the event log row. */
export interface NotifiableTaskEvent {
  readonly taskId: string;
  readonly taskReference: string;
  readonly type: TaskEvent['type'];
  readonly message: string;
}

/** Push services answer 404/410 for a subscription the browser has dropped. */
const GONE_STATUS_CODES = [404, 410];

/**
 * Web push notifications (ADR-065).
 *
 * The dispatcher is called after a task event has been persisted and published
 * to Redis, and it must never affect that path: every failure here is caught,
 * logged and dropped. A person not being told about a task is a degraded
 * experience; a task failing because a push service was slow is a broken
 * platform.
 *
 * Recipients are decided by event kind. An approval is addressed to admins
 * because only an admin may grant one (ADR-029) - notifying a regular user
 * would be notifying somebody who cannot act on it. A task's outcome goes to
 * whoever asked for the task.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.enabled = Boolean(config.push.publicKey && config.push.privateKey);

    if (this.enabled) {
      webpush.setVapidDetails(
        config.push.subject,
        config.push.publicKey,
        config.push.privateKey,
      );
    }
  }

  /** Whether push is configured. The portal hides the section when it is not. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  get publicKey(): string {
    return this.config.push.publicKey;
  }

  /**
   * Stores (or refreshes) a browser's subscription.
   *
   * Upsert on `endpoint` rather than insert: the same browser re-subscribing -
   * after clearing storage, or when the push service rotates the endpoint -
   * must not accumulate rows. It also re-points the row at the current user,
   * so a shared machine hands the subscription to whoever last signed in.
   */
  async subscribe(userId: string, dto: SubscribePushDto, userAgent: string | null): Promise<void> {
    if (!this.enabled) {
      // Silently accepted-and-ignored would leave the portal showing "enabled"
      // for a deployment that can never deliver. The portal does not offer the
      // button when this is off; this is the belt to that braces.
      throw new Error('Push notifications are not configured on this deployment.');
    }

    await this.database.db
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: userAgent?.slice(0, 300) ?? null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          p256dh: dto.keys.p256dh,
          auth: dto.keys.auth,
          userAgent: userAgent?.slice(0, 300) ?? null,
          updatedAt: new Date(),
        },
      });
  }

  /** Removes one browser's subscription. Scoped to the caller: no cross-user deletes. */
  async unsubscribe(userId: string, dto: UnsubscribePushDto): Promise<void> {
    await this.database.db
      .delete(pushSubscriptions)
      .where(
        and(eq(pushSubscriptions.endpoint, dto.endpoint), eq(pushSubscriptions.userId, userId)),
      );
  }

  async preferences(userId: string): Promise<NotificationPreferencesResponse> {
    const [row] = await this.database.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .limit(1);

    // No row means "never changed anything", which is the documented default.
    return {
      approvalRequired: row?.approvalRequired ?? true,
      taskCompleted: row?.taskCompleted ?? true,
      taskFailed: row?.taskFailed ?? true,
      soundEnabled: row?.soundEnabled ?? true,
    };
  }

  async updatePreferences(
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponse> {
    const current = await this.preferences(userId);
    const next: NotificationPreferencesResponse = {
      approvalRequired: dto.approvalRequired ?? current.approvalRequired,
      taskCompleted: dto.taskCompleted ?? current.taskCompleted,
      taskFailed: dto.taskFailed ?? current.taskFailed,
      soundEnabled: dto.soundEnabled ?? current.soundEnabled,
    };

    await this.database.db
      .insert(notificationPreferences)
      .values({ userId, ...next })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: { ...next, updatedAt: new Date() },
      });

    return next;
  }

  /** How many browsers this user has registered. Shown on the account page. */
  async subscriptionCount(userId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    return row?.total ?? 0;
  }

  /**
   * The rows a recipient's push goes to. Kept as its own method (rather than
   * inlined at each call site) so a test can stub one lookup instead of
   * reimplementing the query builder.
   */
  private async subscriptionsFor(
    userId: string,
  ): Promise<{ id: string; endpoint: string; p256dh: string; auth: string }[]> {
    return this.database.db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  }

  /** Sends a test notification to every browser the caller has registered. */
  async sendTest(userId: string): Promise<{ sent: number }> {
    if (!this.enabled) return { sent: 0 };

    const subscriptions = await this.subscriptionsFor(userId);

    const payload: PushPayload = {
      title: 'Cartenz notifications are on',
      body: 'This is a test. You will be told when a task needs approval or finishes.',
      tag: 'cartenz-test',
      url: this.config.push.portalUrl ?? '/',
      sound: 'done',
      event: 'task_completed',
      taskId: '00000000-0000-0000-0000-000000000000',
      projectId: '00000000-0000-0000-0000-000000000000',
      requireInteraction: false,
    };

    let sent = 0;
    for (const subscription of subscriptions) {
      if (await this.deliver(subscription, payload)) sent += 1;
    }
    return { sent };
  }

  /**
   * Notifies the people a task event concerns. Called after publication; never
   * throws, and never awaited by the caller's critical path.
   */
  async dispatchForEvent(event: NotifiableTaskEvent): Promise<void> {
    if (!this.enabled) return;
    const type = event.type;
    if (!isNotifyingEvent(type)) return;

    try {
      const [task] = await this.database.db
        .select({
          id: agentTasks.id,
          reference: agentTasks.reference,
          projectId: agentTasks.projectId,
          createdByUserId: agentTasks.createdByUserId,
          projectName: projects.name,
        })
        .from(agentTasks)
        .innerJoin(projects, eq(projects.id, agentTasks.projectId))
        .where(eq(agentTasks.id, event.taskId))
        .limit(1);

      if (!task) return;

      const recipients = await this.recipientsFor(type, task.createdByUserId);
      if (recipients.length === 0) return;

      await Promise.all(
        recipients.map(async (recipient) => {
          const preference = await this.preferences(recipient.id);
          if (!eventWanted(type, preference)) return;

          const subscriptions = await this.subscriptionsFor(recipient.id);
          if (subscriptions.length === 0) return;

          const payload = buildPushPayload({
            event: type,
            taskId: task.id,
            taskReference: task.reference,
            projectId: task.projectId,
            projectName: task.projectName,
            portalUrl: this.config.push.portalUrl,
            soundEnabled: preference.soundEnabled,
          });

          await Promise.all(
            subscriptions.map((subscription) => this.deliver(subscription, payload)),
          );
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Push dispatch failed for ${event.taskReference} (${event.type}): ${(error as Error).message}`,
      );
    }
  }

  /**
   * Who is told about an event. Approvals go to active admins - the only rank
   * that may grant one - and outcomes to the person who created the task.
   */
  private async recipientsFor(
    event: NotifyingEvent,
    createdByUserId: string | null,
  ): Promise<{ id: string }[]> {
    if (event === 'approval_required') {
      return this.database.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.isAdmin, true), eq(users.isActive, true)));
    }

    if (!createdByUserId) return [];
    return this.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, createdByUserId), eq(users.isActive, true)));
  }

  /**
   * One delivery. Returns whether it landed.
   *
   * A push service answering 404 or 410 is telling us the subscription no
   * longer exists - the browser was uninstalled or storage was cleared. Those
   * rows are deleted rather than retried forever, which is what keeps this
   * table from growing into a list of devices that are gone.
   */
  private async deliver(
    subscription: { id: string; endpoint: string; p256dh: string; auth: string },
    payload: PushPayload,
  ): Promise<boolean> {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        { TTL: 3600 },
      );

      await this.database.db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: new Date() })
        .where(eq(pushSubscriptions.id, subscription.id));
      return true;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode !== undefined && GONE_STATUS_CODES.includes(statusCode)) {
        await this.database.db
          .delete(pushSubscriptions)
          .where(inArray(pushSubscriptions.id, [subscription.id]));
        this.logger.log(`Removed expired push subscription ${subscription.id} (${statusCode}).`);
        return false;
      }

      this.logger.warn(`Push delivery failed: ${(error as Error).message}`);
      return false;
    }
  }
}

export function eventWanted(
  event: NotifyingEvent,
  preferences: NotificationPreferencesResponse,
): boolean {
  if (event === 'approval_required') return preferences.approvalRequired;
  if (event === 'task_completed') return preferences.taskCompleted;
  return preferences.taskFailed;
}
