import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ProjectModulesService } from './project-modules.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * The installed-modules route (ADR-056).
 *
 * A single GET: what is actually installed in a project's own provisioned
 * instance, read fresh every time (no cache, no stored history - see
 * ProjectModulesService for why). Scoped to a project and gated by the
 * authorisation service inside the read service, the same posture as backups.
 */
@Controller('projects')
export class ProjectModulesController {
  constructor(private readonly modules: ProjectModulesService) {}

  @Get(':projectId/installed-modules')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const result = await this.modules.list(user, projectId);
    return {
      available: result.available,
      reason: result.reason,
      modules: result.modules,
    };
  }
}
