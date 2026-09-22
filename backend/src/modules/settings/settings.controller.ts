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
  Query,
} from '@nestjs/common';
import {
  AddModelProviderDto,
  DiscoverModelsDto,
  ReorderModelProvidersDto,
  UpdateModelProviderDto,
} from './dto/model-settings.dto';
import { ModelSettingsService } from './model-settings.service';
import { OdooSettingsService } from './odoo-settings.service';
import { OdooVersionsService } from './odoo-versions.service';
import { UpdateOdooSettingsDto } from './dto/odoo-settings.dto';
import {
  CreateOdooVersionRepositoryDto,
  UpdateOdooVersionRepositoryDto,
} from './dto/odoo-versions.dto';
import { ModelProviderResolver } from '../../agent/model/model-provider-resolver';
import { GitService } from '../../agent/git/git.service';
import { GitCredentialsService } from './git-credentials.service';
import {
  CreateGitCredentialDto,
  TestGitCredentialDto,
  UpdateGitCredentialDto,
} from './dto/git-credentials.dto';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import type { OdooEdition } from '../../core/enums';

/**
 * Deployment settings at /api/v1/settings (ADR-023, ADR-033, ADR-044).
 *
 * One settings surface rather than one per region, because neither the AI
 * provider chain nor the Odoo estate varies by region — region is an access
 * boundary, and these are operator configuration.
 *
 * Readable by any signed-in account, because "which AIs are tried, and do they
 * call out" is something everyone submitting a task should be able to see.
 * Writable only by an admin, because it spends money and sends repository source
 * to a third party.
 *
 * Every write invalidates the resolver's cache: it is keyed on the summed
 * revision of the enabled rows, and dropping it here means a change applies to
 * the next task rather than whenever that revision is next read.
 */
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly modelSettings: ModelSettingsService,
    private readonly odooSettings: OdooSettingsService,
    private readonly odooVersions: OdooVersionsService,
    private readonly gitCredentials: GitCredentialsService,
    private readonly git: GitService,
    private readonly providers: ModelProviderResolver,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  @Get('model-providers')
  async listModelProviders() {
    return this.modelSettings.list();
  }

  @Get('odoo-settings')
  async getOdooSettings() {
    return this.odooSettings.get();
  }

  @Put('odoo-settings')
  async updateOdooSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateOdooSettingsDto,
  ) {
    await this.authz.requireAdmin(user);
    return this.odooSettings.update(user.userId, dto);
  }

  /**
   * The per-version Odoo source catalog (ADR-045). Readable by any signed-in
   * account for the same reason the paths above are: which Odoo a project will
   * be generated against is something everyone creating one should be able to
   * see. Writable only by an admin, because it decides what the agent reads and
   * what a generated project runs.
   */
  @Get('odoo-versions')
  async listOdooVersions() {
    return this.odooVersions.list();
  }

  /**
   * The module picker's catalogue (ADR-056): every installable module a
   * project of this version/edition could run against, read live from the
   * host's manifests. No admin guard — the same "everyone creating a project
   * should see this" reasoning as the GET above, since every user hits this
   * during creation, not only operators.
   */
  @Get('odoo-versions/:version/modules')
  async listOdooVersionModules(
    @Param('version') version: string,
    @Query('edition') edition?: string,
  ) {
    const resolvedEdition: OdooEdition = edition === 'community' ? 'community' : 'enterprise';
    const modules = await this.odooVersions.modulesFor(version, resolvedEdition);
    return { version, edition: resolvedEdition, modules };
  }

  @Post('odoo-versions')
  @HttpCode(HttpStatus.CREATED)
  async addOdooVersionRepository(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOdooVersionRepositoryDto,
  ) {
    await this.authz.requireAdmin(user);
    return this.odooVersions.create(user.userId, dto);
  }

  @Patch('odoo-versions/:rowId')
  async updateOdooVersionRepository(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: UpdateOdooVersionRepositoryDto,
  ) {
    await this.authz.requireAdmin(user);
    return this.odooVersions.update(user.userId, rowId, dto);
  }

  @Delete('odoo-versions/:rowId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeOdooVersionRepository(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    await this.authz.requireAdmin(user);
    await this.odooVersions.remove(user.userId, rowId);
  }

  @Post('model-providers')
  @HttpCode(HttpStatus.CREATED)
  async addModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddModelProviderDto,
  ) {
    await this.authz.requireAdmin(user);
    const row = await this.modelSettings.addRow(user.userId, dto);
    this.providers.invalidate();
    return row;
  }

  /**
   * Declared before the :rowId routes, and it has to stay there. Nest matches in
   * declaration order, so with :rowId first this path binds rowId to the literal
   * "order" and reorder becomes unreachable - a route that answers rather than
   * 404s, which is the kind of dead endpoint nobody notices.
   */
  @Patch('model-providers/order')
  async reorderModelProviders(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReorderModelProvidersDto,
  ) {
    await this.authz.requireAdmin(user);
    const result = await this.modelSettings.reorder(user.userId, dto.order);
    this.providers.invalidate();
    return result;
  }

  @Patch('model-providers/:rowId')
  async updateModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: UpdateModelProviderDto,
  ) {
    await this.authz.requireAdmin(user);
    const row = await this.modelSettings.updateRow(rowId, user.userId, dto);
    this.providers.invalidate();
    return row;
  }

  @Delete('model-providers/:rowId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeModelProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    await this.authz.requireAdmin(user);
    await this.modelSettings.removeRow(rowId, user.userId);
    this.providers.invalidate();
  }

  /**
   * Calls every enabled provider once, in priority order, and reports on each.
   *
   * Worth an endpoint because the alternative way to discover a wrong key is a
   * task that fails after cloning a repository and producing a plan. The prompt
   * carries no repository content, so this is safe to run before any project is
   * connected.
   */
  @Post('model-providers/test')
  async testModelProviderChain(@CurrentUser() user: AuthenticatedUser) {
    await this.authz.requireAdmin(user);
    return this.providers.testChain(user.userId);
  }

  /**
   * Asks an OpenAI-compatible endpoint what models it serves.
   *
   * Declared before `:rowId/test` below: both are POST under
   * `model-providers/`, and a route declared later never gets a chance to match
   * a request the earlier one already claims.
   */
  @Post('model-providers/discover-models')
  async discoverModels(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DiscoverModelsDto,
  ) {
    await this.authz.requireAdmin(user);
    return { models: await this.providers.discoverModels(dto.baseUrl, dto.apiKey) };
  }

  @Post('model-providers/:rowId/test')
  async testModelProviderRow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    await this.authz.requireAdmin(user);
    return this.providers.testRow(rowId, user.userId);
  }

  /**
   * Deployment-wide git credentials (ADR-058).
   *
   * Registered once here, then used as the default whenever a project-creation
   * form needs to read a private repository — so the same SSH key is not pasted
   * into every form, which is where a paste that loses its line breaks produced
   * `Load key "...": error in libcrypto` and read like a GitHub permissions fault.
   *
   * Readable by any signed-in account because the creation form needs the list
   * to offer a choice; writable only by an admin, because a credential stored
   * here is one every project can reach a remote with. No response ever contains
   * the value: the shape has nowhere to put one.
   */
  @Get('git-credentials')
  async listGitCredentials() {
    return { credentials: await this.gitCredentials.list() };
  }

  @Post('git-credentials')
  @HttpCode(HttpStatus.CREATED)
  async addGitCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateGitCredentialDto,
  ) {
    await this.authz.requireAdmin(user);
    return this.gitCredentials.create(user.userId, dto);
  }

  @Patch('git-credentials/:id')
  async updateGitCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGitCredentialDto,
  ) {
    await this.authz.requireAdmin(user);
    return this.gitCredentials.update(user.userId, id, dto);
  }

  @Delete('git-credentials/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeGitCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.authz.requireAdmin(user);
    await this.gitCredentials.remove(user.userId, id);
  }

  /**
   * Proves a registered credential against a repository, and records the result
   * on the row so the settings page can show whether it was ever confirmed.
   *
   * Declared before `:id/test` has no equivalent here (there is only one POST
   * under this path), but the pattern of testing rather than trusting follows
   * `model-providers/test`: the value of an endpoint like this is that it fails
   * here, on the settings page, rather than on the first task of a project.
   */
  @Post('git-credentials/:id/test')
  async testGitCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestGitCredentialDto,
  ) {
    await this.authz.requireAdmin(user);

    const credential = await this.gitCredentials.resolveForHost({
      credentialId: id,
      host: this.gitCredentials.hostOf(dto.repositoryUrl),
    });

    if (!credential) {
      // resolveForHost returning null means the row is missing or disabled; the
      // error names which, because "it did not work" is not actionable.
      const error = 'That credential is disabled or no longer exists.';
      await this.gitCredentials.recordVerification(id, error);
      return { ok: false, branches: [], error };
    }

    try {
      const branches = await this.git.listRemoteBranches(dto.repositoryUrl, {
        credential: { kind: credential.kind, value: credential.value },
      });

      await this.gitCredentials.recordVerification(id, null);
      await this.audit.record({
        event: AUDIT_EVENTS.GIT_CREDENTIAL_TESTED,
        userId: user.userId,
        metadata: { id, repositoryUrl: dto.repositoryUrl, ok: true, branchCount: branches.length },
      });

      return { ok: true, branches, error: null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.gitCredentials.recordVerification(id, detail);
      await this.audit.record({
        event: AUDIT_EVENTS.GIT_CREDENTIAL_TESTED,
        userId: user.userId,
        metadata: { id, repositoryUrl: dto.repositoryUrl, ok: false },
      });

      // Returned rather than thrown: "this key cannot reach that repository" is
      // an answer the form renders, not a failed request.
      return { ok: false, branches: [], error: detail };
    }
  }
}
