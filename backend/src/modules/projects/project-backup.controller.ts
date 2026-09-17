import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ProjectBackupService } from './project-backup.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * The per-client backup routes (ADR-054).
 *
 * GET reports whether this deployment can take one, and the project's recent
 * backups; POST takes one on demand. Both are scoped to a project and gated by
 * the authorisation service inside the backup service, so a person who cannot
 * open a project cannot back it up or read where its backups are.
 */
@Controller('projects')
export class ProjectBackupController {
  constructor(private readonly backups: ProjectBackupService) {}

  @Get(':projectId/backups')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const availability = this.backups.availability();
    return {
      available: availability.available,
      reason: availability.reason,
      backups: await this.backups.list(user, projectId),
    };
  }

  @Post(':projectId/backups')
  @HttpCode(HttpStatus.OK)
  async run(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const outcome = await this.backups.request(user, projectId);
    return {
      backup: outcome.kind === 'skipped' ? null : outcome.backup,
      message:
        outcome.kind === 'taken'
          ? `Backup ${outcome.backup.backupId ?? outcome.backup.id} was taken.`
          : outcome.message,
    };
  }
}
