import { Injectable, Logger } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { agentModelCalls } from '../../core/database/schema';
import type { BoundaryFinding } from '../../core/ai-boundary/boundary-types';

export interface RecordModelCallInput {
  readonly taskId: string;
  readonly organizationId: string;
  readonly operation: 'planning' | 'implementation';
  readonly providerId: string;
  readonly model: string;
  readonly calledExternalService: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly steps: number;
  readonly toolCalls?: number;
  readonly boundaryFindings: readonly BoundaryFinding[];
  readonly redactionCount: number;
  readonly boundaryRefused?: boolean;
  readonly haltReason?: string;
  readonly failureReason?: string;
}

/**
 * Writes the model call record (ADR-020).
 *
 * Never throws into the caller: losing a usage record is preferable to failing a
 * task that otherwise succeeded, and the alternative would make this table a
 * single point of failure for every model-backed run. The same reasoning as the
 * audit service, for the same reason.
 */
@Injectable()
export class ModelCallRecorder {
  private readonly logger = new Logger(ModelCallRecorder.name);

  constructor(private readonly database: DatabaseService) {}

  async record(input: RecordModelCallInput): Promise<void> {
    try {
      await this.database.db.insert(agentModelCalls).values({
        taskId: input.taskId,
        organizationId: input.organizationId,
        operation: input.operation,
        providerId: input.providerId,
        model: input.model,
        calledExternalService: input.calledExternalService,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        durationMs: input.durationMs,
        steps: input.steps,
        toolCalls: input.toolCalls ?? 0,
        boundaryFindings: [...input.boundaryFindings],
        redactionCount: input.redactionCount,
        boundaryRefused: input.boundaryRefused ?? false,
        haltReason: input.haltReason ?? null,
        failureReason: input.failureReason ?? null,
      });
    } catch (error) {
      this.logger.error(`Failed to record a model call: ${(error as Error).message}`);
    }
  }

  /** Calls made for one task, oldest first, for the task detail. */
  async listForTask(taskId: string) {
    return this.database.db
      .select()
      .from(agentModelCalls)
      .where(eq(agentModelCalls.taskId, taskId))
      .orderBy(agentModelCalls.createdAt);
  }

  /** Organisation totals, for cost visibility on the dashboard. */
  async summariseForOrganization(organizationId: string) {
    const [row] = await this.database.db
      .select({
        calls: sql<number>`count(*)::int`,
        externalCalls: sql<number>`count(*) filter (where called_external_service)::int`,
        inputTokens: sql<number>`coalesce(sum(input_tokens), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(output_tokens), 0)::int`,
        redactions: sql<number>`coalesce(sum(redaction_count), 0)::int`,
        refusals: sql<number>`count(*) filter (where boundary_refused)::int`,
      })
      .from(agentModelCalls)
      .where(eq(agentModelCalls.organizationId, organizationId));

    return row ?? {
      calls: 0,
      externalCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      redactions: 0,
      refusals: 0,
    };
  }

  /** Most recent calls in an organisation, for the audit surface. */
  async recentForOrganization(organizationId: string, limit = 20) {
    return this.database.db
      .select()
      .from(agentModelCalls)
      .where(eq(agentModelCalls.organizationId, organizationId))
      .orderBy(desc(agentModelCalls.createdAt))
      .limit(Math.min(limit, 100));
  }
}
