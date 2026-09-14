import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { GitHubRepositoryService } from './github-repository.service';
import { ProjectEnvironmentsService } from './project-environments.service';
import { ProjectProvisioningService } from './project-provisioning.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AgentModule],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    ProjectEnvironmentsService,
    ProjectProvisioningService,
    GitHubRepositoryService,
  ],
  exports: [
    ProjectsService,
    ProjectEnvironmentsService,
    ProjectProvisioningService,
    GitHubRepositoryService,
  ],
})
export class ProjectsModule {}
