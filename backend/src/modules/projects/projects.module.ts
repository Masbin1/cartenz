import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { GitHubRepositoryService } from './github-repository.service';
import { ProjectEnvironmentsService } from './project-environments.service';
import { ProjectProvisioningService } from './project-provisioning.service';
import { ProjectDeploymentService } from './project-deployment.service';
import { ProjectPreviewService } from './project-preview.service';
import { ProjectPreviewController } from './project-preview.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AgentModule],
  controllers: [ProjectsController, ProjectPreviewController],
  providers: [
    ProjectsService,
    ProjectEnvironmentsService,
    ProjectProvisioningService,
    ProjectDeploymentService,
    ProjectPreviewService,
    GitHubRepositoryService,
  ],
  exports: [
    ProjectsService,
    ProjectEnvironmentsService,
    ProjectProvisioningService,
    ProjectDeploymentService,
    ProjectPreviewService,
    GitHubRepositoryService,
  ],
})
export class ProjectsModule {}
