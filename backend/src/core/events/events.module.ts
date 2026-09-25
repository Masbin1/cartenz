import { Global, Module } from '@nestjs/common';
import { TaskEventPublisher } from './task-event-publisher.service';
import { NotificationsModule } from '../../modules/notifications/notifications.module';

@Global()
@Module({
  imports: [NotificationsModule],
  providers: [TaskEventPublisher],
  exports: [TaskEventPublisher],
})
export class EventsModule {}
