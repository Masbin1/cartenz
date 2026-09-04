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
import { OrganizationsService } from './organizations.service';
import {
  AddMemberDto,
  CreateOrganizationDto,
  UpdateMemberRoleDto,
} from './dto/organization.dto';
import {
  AddModelProviderDto,
  DiscoverModelsDto,
  ReorderModelProvidersDto,
  UpdateModelProviderDto,
} from './dto/model-settings.dto';
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
   * The organisation's model providers, tried in priority order (ADR-023,
   * extended to a failover chain).
   *
   * Readable by any member, because "which AIs are tried, in what order, and do
   * they call out" is something everyone submitting a task should be able to
   * see. Writable, reorderable and testable only by an owner or admin, because
   * it spends money and it sends repository source to a third party.
   *
   * Every write and reorder invalidates the resolver's cache: it is keyed on the
   * summed revision of the enabled rows, and dropping it here means a change
   * applies to the next task rather than whenever that revision is next read.
   */
  @Get(':organizationId/model-providers')
  async listModelProviders(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId);
    return this.modelSettings.list(organizationId);
  }

  @Post(':organizationId/model-providers')
  @HttpCode(HttpStatus.CREATED)
  async addModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: AddModelProviderDto,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    const row = await this.modelSettings.addRow(organizationId, user.userId, dto);
    this.providers.invalidate(organizationId);
    return row;
  }

  /**
   * Declared before the :rowId routes, and it has to stay there. Nest matches in
   * declaration order, so with :rowId first this path binds rowId to the literal
   * "order" and reorder becomes unreachable - a route that answers rather than
   * 404s, which is the kind of dead endpoint nobody notices.
   */
  @Patch(':organizationId/model-providers/order')
  async reorderModelProviders(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: ReorderModelProvidersDto,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    const result = await this.modelSettings.reorder(organizationId, user.userId, dto.order);
    this.providers.invalidate(organizationId);
    return result;
  }

  @Patch(':organizationId/model-providers/:rowId')
  async updateModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: UpdateModelProviderDto,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    const row = await this.modelSettings.updateRow(organizationId, rowId, user.userId, dto);
    this.providers.invalidate(organizationId);
    return row;
  }

  @Delete(':organizationId/model-providers/:rowId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    await this.modelSettings.removeRow(organizationId, rowId, user.userId);
    this.providers.invalidate(organizationId);
  }

  /**
   * Calls every enabled provider once, in priority order, and reports on each.
   *
   * Worth an endpoint because the alternative way to discover a wrong key is a
   * task that fails after cloning a repository and producing a plan. The prompt
   * carries no repository content, so this is safe to run before any project is
   * connected.
   */
  @Post(':organizationId/model-providers/test')
  async testModelProviderChain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    return this.providers.testChain(organizationId, user.userId);
  }

  /**
   * Asks an OpenAI-compatible endpoint what models it serves.
   *
   * Declared before `:rowId/test` below: both are POST under
   * `model-providers/`, and a route declared later never gets a chance to match
   * a request the earlier one already claims.
   */
  @Post(':organizationId/model-providers/discover-models')
  async discoverModels(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: DiscoverModelsDto,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    return { models: await this.providers.discoverModels(dto.baseUrl, dto.apiKey) };
  }

  @Post(':organizationId/model-providers/:rowId/test')
  async testModelProviderRow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');
    return this.providers.testRow(organizationId, rowId, user.userId);
  }
}
