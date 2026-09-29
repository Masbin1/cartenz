import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ProjectConnectedInstanceService } from './project-connected-instance.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * A connected odoo.sh project's own provisioned instance (ADR-069).
 *
 * GET reports whether this deployment can create one (provisioning and HTTPS
 * both on); POST queues the creation. The instance is empty and reachable over
 * HTTPS with the database manager open, for the project owner to restore their
 * own backup into. The agent never works against it (ADR-050 §3).
 */
@Controller('projects')
export class ProjectConnectedInstanceController {
  constructor(private readonly connectedInstance: ProjectConnectedInstanceService) {}

  @Get(':projectId/connected-instance/availability')
  availability() {
    return this.connectedInstance.availability();
  }

  @Post(':projectId/connected-instance')
  @HttpCode(HttpStatus.ACCEPTED)
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.connectedInstance.request(user, projectId);
  }

  @Post(':projectId/connected-instance/master-password/reveal')
  @HttpCode(HttpStatus.OK)
  revealMasterPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.connectedInstance.revealMasterPassword(user, projectId);
  }
}
