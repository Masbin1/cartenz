import { Controller, Get } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { DatabaseService } from '../../core/database/database.service';
import { organizationMembers, organizations } from '../../core/database/schema';

/**
 * /api/v1/users/me — the caller's own profile and organisation memberships.
 *
 * The portal calls this once after sign-in to learn which organisations the user
 * belongs to and in what role, so that navigation and permission-dependent
 * controls do not have to be inferred from a failed request.
 */
@Controller('users')
export class MeController {
  constructor(private readonly database: DatabaseService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    const memberships = await this.database.db
      .select({
        organizationId: organizations.id,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, user.userId));

    return {
      id: user.userId,
      email: user.email,
      name: user.name,
      organizations: memberships,
    };
  }
}
