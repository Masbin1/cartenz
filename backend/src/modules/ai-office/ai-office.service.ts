import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { agentActions, agentTasks, approvals, projects } from '../../core/database/schema';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { AGENT_TASK_STATUSES, type AgentTaskStatus } from '../../agent/task-state';
import {
  describeAction,
  isLiveStatus,
  phaseFor,
  progressFor,
  type BoardPhase,
} from './ai-office-board';

export interface BoardCard {
  readonly taskId: string;
  readonly taskReference: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly prompt: string;
  readonly status: AgentTaskStatus;
  readonly phase: BoardPhase;
  readonly progress: number;
  readonly currentAction: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string;
}

export interface AttentionItem {
  readonly approvalId: string;
  readonly taskId: string;
  readonly taskReference: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly action: string;
  readonly requiredReason: string;
  readonly requestedAt: string;
}

export interface QueueItem {
  readonly taskId: string;
  readonly taskReference: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly prompt: string;
  readonly status: AgentTaskStatus;
  readonly createdAt: string;
}

export interface QueueView {
  /** Tasks created or queued but not yet picked up, oldest first. */
  readonly waiting: QueueItem[];
  /** How many tasks can run at once across the platform. */
  readonly capacity: number;
  /** How many are occupying a worker right now. */
  readonly running: number;
}

export interface ActivityQuery {
  /** ISO timestamp; return actions strictly older than this. */
  readonly before?: string;
  readonly limit?: number;
}

export interface ActivityItem {
  readonly id: string;
  readonly taskId: string;
  readonly taskReference: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly actionType: string;
  readonly toolName: string | null;
  readonly status: string;
  readonly taskStatus: AgentTaskStatus;
  /** A one-line summary, or null for an action type that is not rendered. */
  readonly summary: string | null;
  readonly at: string;
}

/**
 * A task that finished recently, for the "just finished" strip.
 *
 * Kept separate from `BoardCard` on purpose: the floor's desks are live tasks,
 * and a finished task is not working. The strip still shows the ending room, so
 * the transition a viewer just watched - a desk emptying - has somewhere to
 * land instead of silently vanishing. No phase: every finished task ends in the
 * same place, so the field would carry no information.
 */
export interface FinishedCard {
  readonly taskId: string;
  readonly taskReference: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly prompt: string;
  readonly status: AgentTaskStatus;
  readonly endedAt: string;
}

export interface BoardSummary {
  readonly live: number;
  readonly needsAttention: number;
  readonly completedToday: number;
  readonly failedToday: number;
}

/**
 * Reads for the AI Office board (PRD docs/AI-OFFICE-PRD-draft.md, phase 1).
 *
 * Every query here is scoped by the same rule that decides whether a task can
 * be opened at all (`decideProjectAccess`, ADR-043): admin sees everything,
 * everyone else sees projects they created or were granted. There is
 * deliberately no separate "AI Office" permission: the board shows a slice of
 * the same tasks the caller could already open from Projects.
 */
@Injectable()
export class AiOfficeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    /**
     * Read for one number the board shows: how many workers can run at once.
     * Without it a board showing three cards and one worker looks like a bug
     * rather than a queue.
     */
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The board: one card per task currently occupying a worker, plus the last
   * action recorded for it. `LATERAL` rather than a window function, so the
   * planner can use the `agent_actions_task_sequence_unique` index to fetch the
   * single latest row per task instead of sorting the whole table.
   */
  async board(
    user: AuthenticatedUser,
  ): Promise<{ cards: BoardCard[]; recent: FinishedCard[]; summary: BoardSummary }> {
    const scoped = await this.authz.readableProjectIds(user);
    if (scoped !== null && scoped.length === 0) {
      return {
        cards: [],
        recent: [],
        summary: { live: 0, needsAttention: 0, completedToday: 0, failedToday: 0 },
      };
    }

    const liveStatuses = AGENT_TASK_STATUSES.filter(isLiveStatus);
    const projectFilter = scoped === null ? sql`true` : inArray(agentTasks.projectId, scoped);

    const rows = await this.database.db
      .select({
        taskId: agentTasks.id,
        taskReference: agentTasks.reference,
        projectId: agentTasks.projectId,
        projectName: projects.name,
        prompt: agentTasks.prompt,
        status: agentTasks.status,
        startedAt: agentTasks.startedAt,
        updatedAt: agentTasks.updatedAt,
        action: sql<{
          actionType: string;
          toolName: string | null;
          status: string;
          path: string | null;
          transitionTo: string | null;
        } | null>`(
          select jsonb_build_object(
            'actionType', a.action_type,
            'toolName', a.tool_name,
            'status', a.status,
            'path', a.input ->> 'path',
            'transitionTo', a.output ->> 'to'
          )
          from agent_actions a
          where a.task_id = ${agentTasks.id}
          order by a.sequence desc
          limit 1
        )`,
      })
      .from(agentTasks)
      .innerJoin(projects, eq(projects.id, agentTasks.projectId))
      .where(and(projectFilter, inArray(agentTasks.status, liveStatuses)))
      .orderBy(desc(agentTasks.updatedAt))
      .limit(200);

    const cards: BoardCard[] = rows.map((row) => {
      // The column is declared with the status enum, but drizzle widens it to
      // string on select; the state machine is the only writer, so the cast is
      // a type narrowing, not a trust decision.
      const status = row.status as AgentTaskStatus;
      return {
        taskId: row.taskId,
        taskReference: row.taskReference,
        projectId: row.projectId,
        projectName: row.projectName,
        prompt: row.prompt,
        status,
        phase: phaseFor(status),
        progress: progressFor(status),
        currentAction: describeAction(row.action),
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        updatedAt: row.updatedAt.toISOString(),
      };
    });

    const [summary, recent] = await Promise.all([
      this.summary(scoped),
      this.recentlyFinished(scoped),
    ]);

    return { cards, recent, summary };
  }

  /**
   * The tasks that ended in the last few hours, newest first.
   *
   * This exists so an idle office still shows what it did: with no live task the
   * floor is correctly empty, and without this the page would look broken rather
   * than quiet. The window is short and the cap small - it is a tail on the live
   * view, not a history browser (the activity feed serves that).
   */
  private async recentlyFinished(
    scoped: string[] | null,
    hours = 3,
    cap = 12,
  ): Promise<FinishedCard[]> {
    const projectFilter = scoped === null ? sql`true` : inArray(agentTasks.projectId, scoped);

    const rows = await this.database.db
      .select({
        taskId: agentTasks.id,
        taskReference: agentTasks.reference,
        projectId: agentTasks.projectId,
        projectName: projects.name,
        prompt: agentTasks.prompt,
        status: agentTasks.status,
        updatedAt: agentTasks.updatedAt,
      })
      .from(agentTasks)
      .innerJoin(projects, eq(projects.id, agentTasks.projectId))
      .where(
        and(
          projectFilter,
          inArray(agentTasks.status, ['completed', 'failed', 'cancelled']),
          sql`${agentTasks.updatedAt} >= now() - (${hours} || ' hours')::interval`,
        ),
      )
      .orderBy(desc(agentTasks.updatedAt))
      .limit(cap);

    return rows.map((row) => {
      const status = row.status as AgentTaskStatus;
      return {
        taskId: row.taskId,
        taskReference: row.taskReference,
        projectId: row.projectId,
        projectName: row.projectName,
        prompt: row.prompt,
        status,
        endedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private async summary(scoped: string[] | null): Promise<BoardSummary> {
    const projectFilter = scoped === null ? sql`true` : inArray(agentTasks.projectId, scoped);
    const liveStatuses = AGENT_TASK_STATUSES.filter(isLiveStatus);

    const [liveRow] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentTasks)
      .where(and(projectFilter, inArray(agentTasks.status, liveStatuses)));

    const [attentionRow] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .innerJoin(agentTasks, eq(agentTasks.id, approvals.taskId))
      .where(and(projectFilter, eq(approvals.status, 'pending')));

    const [completedRow] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentTasks)
      .where(
        and(
          projectFilter,
          eq(agentTasks.status, 'completed'),
          sql`${agentTasks.completedAt} >= current_date`,
        ),
      );

    const [failedRow] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentTasks)
      .where(
        and(
          projectFilter,
          eq(agentTasks.status, 'failed'),
          sql`${agentTasks.completedAt} >= current_date`,
        ),
      );

    return {
      live: liveRow?.count ?? 0,
      needsAttention: attentionRow?.count ?? 0,
      completedToday: completedRow?.count ?? 0,
      failedToday: failedRow?.count ?? 0,
    };
  }

  /**
   * Tasks that have been created or queued but have not started, and how many
   * can actually run at once. `created`/`queued` are the only states where a
   * task occupies no worker; every later state is someone working.
   */
  async queue(user: AuthenticatedUser): Promise<QueueView> {
    const scoped = await this.authz.readableProjectIds(user);
    const capacity = this.config.agent.workerConcurrency;

    if (scoped !== null && scoped.length === 0) {
      return { waiting: [], capacity, running: 0 };
    }

    const projectFilter = scoped === null ? sql`true` : inArray(agentTasks.projectId, scoped);

    const [waiting, runningRows] = await Promise.all([
      this.database.db
        .select({
          taskId: agentTasks.id,
          taskReference: agentTasks.reference,
          projectId: agentTasks.projectId,
          projectName: projects.name,
          prompt: agentTasks.prompt,
          status: agentTasks.status,
          createdAt: agentTasks.createdAt,
        })
        .from(agentTasks)
        .innerJoin(projects, eq(projects.id, agentTasks.projectId))
        .where(and(projectFilter, inArray(agentTasks.status, ['created', 'queued'])))
        .orderBy(agentTasks.createdAt)
        .limit(50),
      this.database.db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentTasks)
        .where(
          and(
            projectFilter,
            inArray(agentTasks.status, AGENT_TASK_STATUSES.filter(isLiveStatus)),
            ne(agentTasks.status, 'created'),
            ne(agentTasks.status, 'queued'),
          ),
        ),
    ]);

    return {
      waiting: waiting.map((row) => ({
        ...row,
        status: row.status as AgentTaskStatus,
        createdAt: row.createdAt.toISOString(),
      })),
      capacity,
      running: runningRows[0]?.count ?? 0,
    };
  }

  /** The "needs you" queue: every pending approval on a task the caller can reach. */
  async attention(user: AuthenticatedUser): Promise<AttentionItem[]> {
    const scoped = await this.authz.readableProjectIds(user);
    if (scoped !== null && scoped.length === 0) return [];

    const projectFilter = scoped === null ? sql`true` : inArray(agentTasks.projectId, scoped);

    const rows = await this.database.db
      .select({
        approvalId: approvals.id,
        taskId: agentTasks.id,
        taskReference: agentTasks.reference,
        projectId: agentTasks.projectId,
        projectName: projects.name,
        action: approvals.action,
        requiredReason: approvals.requiredReason,
        requestedAt: approvals.requestedAt,
      })
      .from(approvals)
      .innerJoin(agentTasks, eq(agentTasks.id, approvals.taskId))
      .innerJoin(projects, eq(projects.id, agentTasks.projectId))
      .where(and(projectFilter, eq(approvals.status, 'pending')))
      .orderBy(approvals.requestedAt);

    return rows.map((row) => ({
      ...row,
      requestedAt: row.requestedAt.toISOString(),
    }));
  }

  /**
   * The live activity feed: the newest actions across every readable project,
   * newest first.
   *
   * Paged by keyset, not offset: `before` is the `created_at` of the last row
   * the caller holds. An offset would skip or repeat rows as new actions arrive
   * during paging, which is guaranteed here because tasks are running.
   *
   * Only mechanical detail is selected - the tool name, the action type, the
   * task it belongs to. Reasoning rows are excluded in the query, so the agent's
   * narration cannot be rendered even by mistake, and no action payload or file
   * content is read.
   */
  async activity(user: AuthenticatedUser, query: ActivityQuery): Promise<ActivityItem[]> {
    const scoped = await this.authz.readableProjectIds(user);
    if (scoped !== null && scoped.length === 0) return [];

    const limit = Math.min(Math.max(query.limit ?? 40, 1), 200);
    const projectFilter = scoped === null ? sql`true` : inArray(agentTasks.projectId, scoped);

    const rows = await this.database.db
      .select({
        id: agentActions.id,
        taskId: agentTasks.id,
        taskReference: agentTasks.reference,
        projectId: agentTasks.projectId,
        projectName: projects.name,
        actionType: agentActions.actionType,
        toolName: agentActions.toolName,
        status: agentActions.status,
        path: sql<string | null>`${agentActions.input} ->> 'path'`,
        transitionTo: sql<string | null>`${agentActions.output} ->> 'to'`,
        taskStatus: agentTasks.status,
        createdAt: agentActions.createdAt,
      })
      .from(agentActions)
      .innerJoin(agentTasks, eq(agentTasks.id, agentActions.taskId))
      .innerJoin(projects, eq(projects.id, agentTasks.projectId))
      .where(
        and(
          projectFilter,
          // Narration is never published to the portal (ADR-066).
          ne(agentActions.actionType, 'reasoning'),
          query.before ? lt(agentActions.createdAt, new Date(query.before)) : undefined,
        ),
      )
      .orderBy(desc(agentActions.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      taskReference: row.taskReference,
      projectId: row.projectId,
      projectName: row.projectName,
      actionType: row.actionType,
      toolName: row.toolName,
      status: row.status,
      taskStatus: row.taskStatus as AgentTaskStatus,
      summary: describeAction({
        actionType: row.actionType,
        toolName: row.toolName,
        status: row.status,
        path: row.path,
        transitionTo: row.transitionTo,
      }),
      at: row.createdAt.toISOString(),
    }));
  }
}
