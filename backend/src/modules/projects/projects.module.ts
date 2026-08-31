import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { ProjectEnvironmentsService } from './project-environments.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AgentModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectEnvironmentsService],
  exports: [ProjectsService, ProjectEnvironmentsService],
})
export class ProjectsModule {}
