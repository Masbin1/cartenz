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
  Put,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import {
  AddMemberDto,
  CreateOrganizationDto,
  UpdateMemberRoleDto,
} from './dto/organization.dto';
import { WriteModelSettingsDto } from './dto/model-settings.dto';
import { ModelSettingsService } from './model-settings.service';
import { ModelProviderResolver } from '../../agent/model/model-provider-resolver';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/** /api/v1/organizations per chapter 15. */
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly modelSettings: ModelSettingsService,
    private readonly providers: ModelProviderResolver,
    private readonly authz: AuthorizationService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listForUser(user);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrganizationDto) {
    return this.organizations.create(user, dto);
  }

  @Get(':organizationId')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.organizations.findOne(user, organizationId);
  }

  @Get(':organizationId/members')
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.organizations.listMembers(user, organizationId);
  }

  @Post(':organizationId/members')
  @HttpCode(HttpStatus.CREATED)
  addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.organizations.addMember(user, organizationId, dto);
  }

  @Patch(':organizationId/members/:memberUserId')
  updateMemberRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.organizations.updateMemberRole(user, organizationId, memberUserId, dto.role);
  }

  @Delete(':organizationId/members/:memberUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
  ) {
    return this.organizations.removeMember(user, organizationId, memberUserId);
  }

  /**
   * The organisation's model provider (ADR-023).
   *
   * Readable by any member, because "which AI is answering, and does it call out"
   * is something everyone submitting a task should be able to see. Writable only
   * by an owner or admin, because it spends money and it sends repository source
   * to a third party.
   */
  @Get(':organizationId/model-provider')
  async modelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId);
    return this.modelSettings.describe(organizationId);
  }

  @Put(':organizationId/model-provider')
  async setModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: WriteModelSettingsDto,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    const result = await this.modelSettings.write(organizationId, user.userId, dto);

    // The resolver caches a built provider per organisation. Dropping it here
    // means the change applies to the next task rather than after the revision
    // happens to be re-read.
    this.providers.invalidate(organizationId);

    return result;
  }

  @Delete(':organizationId/model-provider')
  async clearModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    const result = await this.modelSettings.clear(organizationId, user.userId);
    this.providers.invalidate(organizationId);
    return result;
  }

  /**
   * Calls the configured provider once, with a trivial prompt, and reports what
   * happened.
   *
   * Worth an endpoint because the alternative way to discover a wrong key is a
   * task that fails after cloning a repository and producing a plan. The prompt
   * carries no repository content, so this is safe to run before any project is
   * connected.
   */
  @Post(':organizationId/model-provider/test')
  async testModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    return this.providers.test(organizationId, user.userId);
  }
}
