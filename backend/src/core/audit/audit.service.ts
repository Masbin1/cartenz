import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { auditLogs } from '../database/schema';
import { redactMetadata } from './redact';
import type { AuditEvent } from './audit-events';

export interface AuditRecord {
  readonly event: AuditEvent;
  readonly organizationId?: string | null;
  readonly projectId?: string | null;
  readonly userId?: string | null;
  readonly ipAddress?: string | null;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The only writer to audit_logs.
 *
 * Every payload passes through redactMetadata, so a caller cannot record a
 * credential even by mistake. Writes never throw into the caller: an audit
 * failure is logged and swallowed, because losing an audit row is preferable to
 * failing the user action that was being recorded - and the alternative would
 * make the audit table a single point of failure for the whole API.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly database: DatabaseService) {}

  async record(entry: AuditRecord): Promise<void> {
    try {
      await this.database.db.insert(auditLogs).values({
        eventType: entry.event,
        organizationId: entry.organizationId ?? null,
        projectId: entry.projectId ?? null,
        userId: entry.userId ?? null,
        ipAddress: entry.ipAddress ?? null,
        metadata: redactMetadata(entry.metadata ?? {}),
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit record ${entry.event}: ${(error as Error).message}`,
      );
    }
  }

  /** Organisation-scoped audit trail, most recent first. */
  async listForOrganization(
    organizationId: string,
    options: { limit?: number; projectId?: string } = {},
  ) {
    const limit = Math.min(options.limit ?? 50, 200);
    const where = options.projectId
      ? and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.projectId, options.projectId))
      : eq(auditLogs.organizationId, organizationId);

    return this.database.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }
}
