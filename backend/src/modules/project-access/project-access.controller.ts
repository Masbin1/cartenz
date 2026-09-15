import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ProjectAccessService } from './project-access.service';
import {
  DecideAccessRequestDto,
  GrantProjectAccessDto,
  RequestProjectAccessDto,
} from './dto/project-access.dto';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/** Who may open a project, and how to ask (ADR-043). */
@Controller()
export class ProjectAccessController {
  constructor(private readonly access: ProjectAccessService) {}

  @Get('projects/:projectId/members')
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.access.listMembers(user, projectId);
  }

  @Post('projects/:projectId/members')
  @HttpCode(HttpStatus.CREATED)
  grant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: GrantProjectAccessDto,
  ) {
    return this.access.grant(user, projectId, dto);
  }

  @Delete('projects/:projectId/members/:memberUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
  ) {
    await this.access.revoke(user, projectId, memberUserId);
  }

  @Post('projects/:projectId/access-requests')
  @HttpCode(HttpStatus.CREATED)
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RequestProjectAccessDto,
  ) {
    return this.access.request(user, projectId, dto);
  }

  @Patch('projects/:projectId/access-requests/:requestId')
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecideAccessRequestDto,
  ) {
    return this.access.decide(user, projectId, requestId, dto);
  }

  @Get('organizations/:organizationId/access-requests')
  listPending(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.access.listPending(user, organizationId);
  }
}
