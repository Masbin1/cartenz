import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ProjectCheckoutService } from './project-checkout.service';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * The local clone routes (ADR-063).
 *
 * A GET that only reads disk, and two POSTs that reach the network: `sync`
 * clones or fast-forwards a branch, `analyze` re-reads a clone that already
 * exists. The GET never contacts the remote, so opening a project page cannot
 * open an SSH connection to GitHub - which also means its `behind` count is as
 * of the last sync, and the page says so.
 *
 * `analyze` is separate from `sync` rather than folded into it because the two
 * differ in what they cost: refreshing a stale module list should not require a
 * network round trip when the code is already on disk.
 */
@Controller('projects')
export class ProjectCheckoutController {
  constructor(
    private readonly checkouts: ProjectCheckoutService,
    private readonly authz: AuthorizationService,
  ) {}

  @Get(':projectId/checkout')
  async status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    await this.authz.requireProjectAccess(user, projectId);
    return this.checkouts.status(projectId);
  }

  /**
   * Brings a branch's local clone up to date, cloning it on first use.
   *
   * A POST on a subresource path rather than a PATCH on the project: it changes
   * what is on this host's disk, not the project's configuration, and the two
   * have no reason to share an authorisation decision.
   */
  @Post(':projectId/checkout/sync')
  @HttpCode(HttpStatus.OK)
  async sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: { branch?: string | null },
  ) {
    await this.authz.requireProjectAccess(user, projectId);
    return this.checkouts.sync(projectId, user.userId, body?.branch ?? null);
  }

  /** Re-reads an existing local clone and rewrites the project's memory from it. */
  @Post(':projectId/checkout/analyze')
  @HttpCode(HttpStatus.OK)
  async analyze(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: { branch?: string | null },
  ) {
    await this.authz.requireProjectAccess(user, projectId);
    return this.checkouts.analyze(projectId, user.userId, body?.branch ?? null);
  }
}
