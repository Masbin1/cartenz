import { Global, Module } from '@nestjs/common';
import { TaskEventPublisher } from './task-event-publisher.service';

@Global()
@Module({
  providers: [TaskEventPublisher],
  exports: [TaskEventPublisher],
})
export class EventsModule {}
