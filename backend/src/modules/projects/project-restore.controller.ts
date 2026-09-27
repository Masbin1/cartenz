import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ProjectRestoreService } from './project-restore.service';
import { RestoreFromBackupDto } from './dto/project.dto';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * Restored copy of a connected odoo.sh project (ADR-067).
 *
 * GET reports whether this deployment can build one and which backup zips an
 * operator has staged; POST queues a build from one of them. The build is a
 * NEW instance on this host for a person to look at real data - the agent
 * keeps working on the project's own standard database (ADR-050 §3).
 */
@Controller('projects')
export class ProjectRestoreController {
  constructor(private readonly restore: ProjectRestoreService) {}

  @Get(':projectId/restored-instance/backups')
  async backups(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const availability = this.restore.availability();
    return {
      available: availability.available,
      reason: availability.reason,
      backups: availability.available ? await this.restore.listFor(user, projectId) : [],
    };
  }

  @Post(':projectId/restored-instance')
  @HttpCode(HttpStatus.ACCEPTED)
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RestoreFromBackupDto,
  ) {
    return this.restore.request(user, projectId, dto.backupFile);
  }
}
