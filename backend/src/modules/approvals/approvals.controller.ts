import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { DecideApprovalDto } from './dto/approval.dto';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * Approval endpoints.
 *
 * The decision routes are mounted under the task, per chapter 15
 * (/tasks/{id}/approve), because an approval is always a decision about a task
 * and the task is what the user is looking at when they make it.
 */
@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get('approvals')
  listPending(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.approvals.listPending(user, organizationId);
  }

  @Get('tasks/:taskId/approvals')
  listForTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.approvals.listForTask(user, taskId);
  }

  @Post('tasks/:taskId/approve')
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.approvals.decide(user, taskId, dto.decision, dto.note);
  }
}
