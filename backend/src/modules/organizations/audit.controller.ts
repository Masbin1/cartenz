import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * Read access to the audit trail.
 *
 * Restricted to admin and above: the trail records who did what, and that is
 * management information rather than something every project member needs.
 */
@Controller('organizations/:organizationId/audit-logs')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');

    return this.audit.listForOrganization(organizationId, {
      projectId,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
