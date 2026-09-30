import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * Web push notifications (ADR-065).
 *
 * Global so the event publisher - which lives in `EventsModule`, itself global -
 * can hand a persisted event to the dispatcher without a circular import:
 * `EventsModule` cannot depend on a feature module, and a feature module's
 * controller needs the same service the publisher calls into.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
