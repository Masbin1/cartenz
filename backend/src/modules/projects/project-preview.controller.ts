import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ProjectPreviewService } from './project-preview.service';
import { StartPreviewDto } from './dto/project-preview.dto';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * The ephemeral preview routes (ADR-052).
 *
 * POST starts one (an action against the host, the same shape as `pull`), GET
 * reports the live one, DELETE tears it down early. All three are scoped to a
 * project and gated by the authorisation service inside the preview service, so
 * a person who cannot open a project cannot preview it.
 */
@Controller('projects')
export class ProjectPreviewController {
  constructor(private readonly previews: ProjectPreviewService) {}

  @Get(':projectId/preview')
  status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.previews.status(user, projectId);
  }

  @Post(':projectId/preview')
  @HttpCode(HttpStatus.OK)
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: StartPreviewDto,
  ) {
    return this.previews.start(user, projectId, dto.taskId);
  }

  @Delete(':projectId/preview')
  stop(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.previews.stop(user, projectId);
  }
}
