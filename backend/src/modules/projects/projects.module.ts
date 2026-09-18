import { Module, forwardRef } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { GitHubRepositoryService } from './github-repository.service';
import { ProjectEnvironmentsService } from './project-environments.service';
import { ProjectProvisioningService } from './project-provisioning.service';
import { ProjectDeploymentService } from './project-deployment.service';
import { ProjectPreviewService } from './project-preview.service';
import { ProjectPreviewController } from './project-preview.controller';
import { ProjectProvisioningQueue } from './project-provisioning.queue';
import { ProjectBackupService } from './project-backup.service';
import { ProjectBackupController } from './project-backup.controller';
import { ProjectModulesService } from './project-modules.service';
import { ProjectModulesController } from './project-modules.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * Projects, and the host actions that act on one: provisioning, deploy,
 * preview, backup.
 *
 * The circular reference to AgentModule is deliberate and is the shape of the
 * domain (ADR-054): the agent workflow takes a backup before a push onto a
 * staging branch, and a backup is a project concern that needs the project's
 * own record. `forwardRef` on both sides records that, as it already does for
 * ApprovalsModule.
 */
@Module({
  imports: [forwardRef(() => AgentModule)],
  controllers: [
    ProjectsController,
    ProjectPreviewController,
    ProjectBackupController,
    ProjectModulesController,
  ],
  providers: [
    ProjectsService,
    ProjectEnvironmentsService,
    ProjectProvisioningService,
    ProjectProvisioningQueue,
    ProjectDeploymentService,
    ProjectPreviewService,
    ProjectBackupService,
    ProjectModulesService,
    GitHubRepositoryService,
  ],
  exports: [
    ProjectsService,
    ProjectEnvironmentsService,
    ProjectProvisioningService,
    ProjectProvisioningQueue,
    ProjectDeploymentService,
    ProjectPreviewService,
    ProjectBackupService,
    ProjectModulesService,
    GitHubRepositoryService,
  ],
})
export class ProjectsModule {}
