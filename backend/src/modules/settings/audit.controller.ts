import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * Read access to the deployment's audit trail.
 *
 * Restricted to admins: the trail records who did what, and that is management
 * information rather than something every project member needs.
 */
@Controller('settings/audit-logs')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
  ) {
    await this.authz.requireAdmin(user);

    return this.audit.listRecent({
      projectId,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
