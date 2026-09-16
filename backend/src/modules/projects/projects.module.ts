import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { GitHubRepositoryService } from './github-repository.service';
import { ProjectEnvironmentsService } from './project-environments.service';
import { ProjectProvisioningService } from './project-provisioning.service';
import { ProjectDeploymentService } from './project-deployment.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AgentModule],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    ProjectEnvironmentsService,
    ProjectProvisioningService,
    ProjectDeploymentService,
    GitHubRepositoryService,
  ],
  exports: [
    ProjectsService,
    ProjectEnvironmentsService,
    ProjectProvisioningService,
    ProjectDeploymentService,
    GitHubRepositoryService,
  ],
})
export class ProjectsModule {}
