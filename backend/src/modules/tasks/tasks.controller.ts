import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CancelTaskDto, CreateTaskDto } from './dto/task.dto';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { ToolRegistry } from '../../agent/tools/tool-registry';
import { AGENT_TASK_STATUSES, TASK_STATUS_LABELS } from '../../agent/task-state';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';

/**
 * Task endpoints, at the paths given in chapter 15: tasks are created under a
 * project, then addressed directly by id.
 */
@Controller()
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly registry: ToolRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('projects/:projectId/tasks')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.tasks.create(user, projectId, dto);
  }

  @Get('projects/:projectId/tasks')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('limit') limit?: string,
  ) {
    return this.tasks.listForProject(user, projectId, limit ? Number(limit) : undefined);
  }

  @Get('projects/:projectId/sessions')
  listSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.tasks.listSessions(user, projectId);
  }

  @Get('tasks/:taskId')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.tasks.findOne(user, taskId);
  }

  @Get('tasks/:taskId/actions')
  actions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.tasks.findOne(user, taskId).then((task) => task.actions);
  }

  @Get('tasks/:taskId/diff')
  diff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.tasks.diff(user, taskId);
  }

  @Get('tasks/:taskId/events')
  events(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.tasks.events(user, taskId);
  }

  @Post('tasks/:taskId/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CancelTaskDto,
  ) {
    return this.tasks.cancel(user, taskId, dto?.reason);
  }

  /**
   * The tool catalogue and the task state machine, so that the portal renders
   * both from the server's definitions rather than duplicating them.
   */
  @Get('agent/capabilities')
  capabilities() {
    const pushEnabled = this.config.git.pushEnabled;

    return {
      tools: this.registry.describe(),
      git: {
        pushEnabled,
        // Phrased for a person deciding whether to connect their repository.
        pushReason: pushEnabled
          ? 'Pushing is enabled (GIT_PUSH_ENABLED=true). Pushes still require an approval.'
          : 'Pushing is disabled (GIT_PUSH_ENABLED=false). The process layer refuses ' +
            '"git push" before a process is built, so no permission or approval can ' +
            'cause a push. Enabling it is an operator change to the server configuration.',
        sshHostKeyPolicy: this.config.git.sshHostKeyPolicy,
      },
      taskStatuses: AGENT_TASK_STATUSES.map((status) => ({
        value: status,
        label: TASK_STATUS_LABELS[status],
      })),
    };
  }
}
