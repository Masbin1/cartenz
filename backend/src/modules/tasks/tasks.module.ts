import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { AgentModule } from '../../agent/agent.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [AgentModule, ProjectsModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
