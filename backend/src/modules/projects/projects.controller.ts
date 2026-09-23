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
  RemoteBranchesDto,
  RestartProjectDto,
  UpdateAgentPermissionsDto,
  UpdateProjectDto,
  UpdateProjectGitAccessDto,
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
    return this.projects.remoteBranchesFor(user, dto);
  }

  /**
   * The folders an on-premise project may be pointed at, read while the creation
   * form is being filled in. Declared before `:projectId` so the literal path
   * wins over the UUID parameter.
   */
  @Get('on-premise-locations')
  onPremiseLocations(@CurrentUser() user: AuthenticatedUser) {
    return this.projects.onPremiseLocations(user);
  }

  @Get(':projectId')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.findOne(user, projectId);
  }

  /**
   * Reveals the Odoo master password for a provisioned instance (ADR-040).
   * admin/owner only, enforced in the service. A GET that returns a secret is
   * unusual, but this is a read (nothing is created or changed) and the value
   * itself never appears in `findOne`'s response - this is the only route
   * that can produce it, and only for the two roles the master password is
   * meant for.
   */
  @Get(':projectId/provisioning-secret')
  revealMasterPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.revealMasterPassword(user, projectId);
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
   * How this project reaches its git remote, and with which credential (ADR-059).
   *
   * Its own path rather than fields on PATCH /:projectId because the transport
   * and the URL move together: saving one without the other is the mismatch this
   * setting exists to prevent.
   */
  @Get(':projectId/git-access')
  gitAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.gitAccess(user, projectId);
  }

  @Patch(':projectId/git-access')
  updateGitAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateProjectGitAccessDto,
  ) {
    return this.projects.updateGitAccess(user, projectId, dto);
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
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });
    return this.environments.add(projectId, dto);
  }

  /** Moves the default target. Refuses to point it at a production environment. */
  @Patch(':projectId/environments/:environmentId/default')
  async setDefaultEnvironment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
  ) {
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });
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

  /**
   * Brings a provisioned instance up to date with its own repository (ADR-049).
   *
   * POST rather than PATCH: this is not an edit to the project row, it is an
   * action against the host — the same shape as the routes that provision and
   * issue certificates. The response carries the resulting commit, so a caller
   * can tell what the instance is now serving.
   */
  @Post(':projectId/pull')
  @HttpCode(HttpStatus.OK)
  pull(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.pull(user, projectId);
  }

  /**
   * Promotes the project's `staging` branch onto `main` on GitHub (ADR-057 §1).
   *
   * The one route in the platform that writes to `main`, and deliberately a
   * named action rather than something a task can trigger: ADR-021 §2 refuses
   * the *task* path onto `main`, and this does not reopen it — it is an
   * explicit, admin-gated operator action, audited as its own event.
   */
  @Post(':projectId/merge-to-main')
  @HttpCode(HttpStatus.OK)
  mergeToMain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.mergeToMain(user, projectId);
  }

  /**
   * Brings the instance onto `branch`'s tip and serves it: pull, `-u all`,
   * restart the unit (ADR-057 §2/§3).
   *
   * Queued rather than inline: the upgrade can outlast a request, so this
   * returns a job reference and the portal polls the project row's
   * `restartStatus` — the same shape selective provisioning already uses.
   */
  @Post(':projectId/restart')
  @HttpCode(HttpStatus.ACCEPTED)
  restart(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RestartProjectDto,
  ) {
    return this.projects.restart(user, projectId, dto.branch);
  }
}
