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
  Query,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import {
  CreateAiProjectDto,
  CreateConnectionDto,
  CreateProjectDto,
  DeleteProjectDto,
  EnvironmentDto,
  ListProjectsQueryDto,
  OnPremiseLocationsQueryDto,
  RemoteBranchesDto,
  UpdateAgentPermissionsDto,
  UpdateProjectDto,
} from './dto/project.dto';
import { ProjectEnvironmentsService } from './project-environments.service';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/** /api/v1/projects per chapter 15. */
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly environments: ProjectEnvironmentsService,
    private readonly authz: AuthorizationService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListProjectsQueryDto) {
    return this.projects.list(user, query);
  }

  /** Connect an existing project. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user, dto);
  }

  /** Create a new project with AI, producing a structured specification. */
  @Post('ai')
  @HttpCode(HttpStatus.CREATED)
  createAiProject(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAiProjectDto) {
    return this.projects.createAiProject(user, dto);
  }

  /**
   * The branches a repository advertises, so environments are picked from a list
   * instead of typed (git refs are case-sensitive: `Staging` is not `staging`).
   *
   * A POST rather than a GET with a query string because it takes a URL and is
   * not cacheable, and its own path rather than a field on create because the
   * branches are needed while the form is still being filled in.
   */
  @Post('remote-branches')
  @HttpCode(HttpStatus.OK)
  remoteBranchesFor(@CurrentUser() user: AuthenticatedUser, @Body() dto: RemoteBranchesDto) {
    return this.projects.remoteBranchesFor(user, dto.organizationId, dto.repositoryUrl);
  }

  /**
   * The folders an on-premise project may be pointed at, read while the creation
   * form is being filled in. Declared before `:projectId` so the literal path
   * wins over the UUID parameter.
   */
  @Get('on-premise-locations')
  onPremiseLocations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OnPremiseLocationsQueryDto,
  ) {
    return this.projects.onPremiseLocations(user, query.organizationId);
  }

  @Get(':projectId')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.findOne(user, projectId);
  }

  @Patch(':projectId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(user, projectId, dto);
  }

  /**
   * Archives a project: reversible, and what most people mean by "remove it from
   * my list". Kept on DELETE for compatibility, but the response says which of
   * the two happened so nobody has to guess from the verb.
   */
  @Delete(':projectId')
  @HttpCode(HttpStatus.OK)
  async archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    await this.projects.archive(user, projectId);
    return {
      archived: true,
      message:
        'The project was archived and is hidden from the project list. Nothing was ' +
        'deleted: restore it, or delete it permanently, from its settings.',
    };
  }

  @Post(':projectId/restore')
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.restore(user, projectId);
  }

  /**
   * Deletes a project and everything it owns, permanently (ADR-024).
   *
   * Its own path rather than a flag on DELETE, so that nothing reaches it by
   * accident: a client that means to archive cannot delete by sending one extra
   * field. Owner-only, refuses while a task is unfinished, and requires the
   * project's name in the body.
   */
  @Delete(':projectId/permanent')
  @HttpCode(HttpStatus.OK)
  destroy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: DeleteProjectDto,
  ) {
    return this.projects.destroy(user, projectId, dto.confirmName);
  }

  @Patch(':projectId/agent-permissions')
  updateAgentPermissions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateAgentPermissionsDto,
  ) {
    return this.projects.updateAgentPermissions(user, projectId, dto.permissions);
  }

  /**
   * The environments a project has (ADR-021). Read by the portal so a task can be
   * pointed at staging rather than at whatever the default branch happens to be.
   */
  @Get(':projectId/environments')
  async listEnvironments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    await this.authz.requireProjectAccess(user, projectId);
    return this.environments.listForProject(projectId);
  }

  @Post(':projectId/environments')
  @HttpCode(HttpStatus.CREATED)
  async addEnvironment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: EnvironmentDto,
  ) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin');
    return this.environments.add(projectId, context.organizationId, dto);
  }

  /** Moves the default target. Refuses to point it at a production environment. */
  @Patch(':projectId/environments/:environmentId/default')
  async setDefaultEnvironment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
  ) {
    await this.authz.requireProjectAccess(user, projectId, 'admin');
    await this.environments.setDefaultTarget(projectId, environmentId);
    return this.environments.listForProject(projectId);
  }

  /** The same probe for a project that already has a repository URL. */
  @Get(':projectId/remote-branches')
  remoteBranches(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.remoteBranches(user, projectId);
  }

  @Post(':projectId/connections')
  @HttpCode(HttpStatus.CREATED)
  createConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateConnectionDto,
  ) {
    return this.projects.createConnection(user, projectId, dto);
  }

  @Delete(':projectId/connections/:connectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.projects.deleteConnection(user, projectId, connectionId);
  }
}
