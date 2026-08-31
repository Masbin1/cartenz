import { Module } from '@nestjs/common';
import { TaskEventsGateway } from './task-events.gateway';

@Module({
  providers: [TaskEventsGateway],
  exports: [TaskEventsGateway],
})
export class RealtimeModule {}
