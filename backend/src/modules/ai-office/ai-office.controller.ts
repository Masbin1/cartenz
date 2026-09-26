import { Controller, Get, Query } from '@nestjs/common';
import { AiOfficeService } from './ai-office.service';
import { CurrentUser } from '../../core/http/current-user.decorator';
import { ActivityQueryDto } from './dto/ai-office.dto';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/** Query for the activity feed: keyset paging, so a running task cannot shift the page. */
/**
 * /api/v1/ai-office (PRD docs/AI-OFFICE-PRD-draft.md, ADR-066).
 *
 * Read-only. Nothing here starts, stops or approves a task - approval stays on
 * the existing approvals routes, so the board cannot become a second path
 * around the policy engine.
 */
@Controller('ai-office')
export class AiOfficeController {
  constructor(private readonly aiOffice: AiOfficeService) {}

  @Get('board')
  board(@CurrentUser() user: AuthenticatedUser) {
    return this.aiOffice.board(user);
  }

  @Get('attention')
  attention(@CurrentUser() user: AuthenticatedUser) {
    return this.aiOffice.attention(user);
  }

  @Get('queue')
  queue(@CurrentUser() user: AuthenticatedUser) {
    return this.aiOffice.queue(user);
  }

  @Get('activity')
  activity(@CurrentUser() user: AuthenticatedUser, @Query() query: ActivityQueryDto) {
    return this.aiOffice.activity(user, { before: query.before, limit: query.limit });
  }
}
