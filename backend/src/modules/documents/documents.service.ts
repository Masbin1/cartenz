import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { projectDocuments } from '../../core/database/schema';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import {
  DocumentExtractionError,
  extractDocumentText,
} from './document-extraction';

/** A document as the list view shows it: metadata, never the text. */
export interface ProjectDocumentSummary {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly createdAt: Date;
}

/** A document as the read view shows it: metadata plus the extracted text. */
export interface ProjectDocumentDetail extends ProjectDocumentSummary {
  readonly textContent: string;
}

export interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async upload(
    user: AuthenticatedUser,
    projectId: string,
    file: UploadedFile,
  ): Promise<ProjectDocumentSummary> {
    const context = await this.authz.requireProjectAccess(user, projectId, 'developer');

    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('The uploaded file is empty.');
    }

    let textContent: string;
    try {
      textContent = await extractDocumentText(file.mimetype, file.buffer);
    } catch (error) {
      if (error instanceof DocumentExtractionError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const [row] = await this.database.db
      .insert(projectDocuments)
      .values({
        organizationId: context.organizationId,
        projectId,
        uploadedByUserId: user.userId,
        filename: file.originalname || 'document',
        mimeType: file.mimetype,
        byteSize: file.size,
        textContent,
      })
      .returning({
        id: projectDocuments.id,
        filename: projectDocuments.filename,
        mimeType: projectDocuments.mimeType,
        byteSize: projectDocuments.byteSize,
        createdAt: projectDocuments.createdAt,
      });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_DOCUMENT_UPLOADED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: {
        documentId: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        extractedChars: textContent.length,
      },
    });

    return row;
  }

  async list(user: AuthenticatedUser, projectId: string): Promise<ProjectDocumentSummary[]> {
    await this.authz.requireProjectAccess(user, projectId, 'viewer');

    return this.database.db
      .select({
        id: projectDocuments.id,
        filename: projectDocuments.filename,
        mimeType: projectDocuments.mimeType,
        byteSize: projectDocuments.byteSize,
        createdAt: projectDocuments.createdAt,
      })
      .from(projectDocuments)
      .where(eq(projectDocuments.projectId, projectId))
      .orderBy(desc(projectDocuments.createdAt));
  }

  async read(
    user: AuthenticatedUser,
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocumentDetail> {
    await this.authz.requireProjectAccess(user, projectId, 'viewer');

    const [row] = await this.database.db
      .select({
        id: projectDocuments.id,
        filename: projectDocuments.filename,
        mimeType: projectDocuments.mimeType,
        byteSize: projectDocuments.byteSize,
        createdAt: projectDocuments.createdAt,
        textContent: projectDocuments.textContent,
      })
      .from(projectDocuments)
      .where(
        and(
          eq(projectDocuments.id, documentId),
          eq(projectDocuments.projectId, projectId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundException('Document not found');
    }

    return row;
  }

  async remove(
    user: AuthenticatedUser,
    projectId: string,
    documentId: string,
  ): Promise<{ id: string }> {
    const context = await this.authz.requireProjectAccess(user, projectId, 'developer');

    const [deleted] = await this.database.db
      .delete(projectDocuments)
      .where(
        and(
          eq(projectDocuments.id, documentId),
          eq(projectDocuments.projectId, projectId),
        ),
      )
      .returning({ id: projectDocuments.id, filename: projectDocuments.filename });

    if (!deleted) {
      throw new NotFoundException('Document not found');
    }

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_DOCUMENT_DELETED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { documentId: deleted.id, filename: deleted.filename },
    });

    return { id: deleted.id };
  }

  /**
   * Loads a task's attached documents by id, in attachment order, for the
   * workflow to pass to the model as prompt parts. Ids that no longer exist or
   * belong to another project are silently dropped: the task still runs on its
   * prompt, because a deleted document is not a reason to fail a run that was
   * already submitted.
   */
  async loadForTask(
    projectId: string,
    documentIds: readonly string[],
  ): Promise<readonly { id: string; filename: string; content: string }[]> {
    if (documentIds.length === 0) return [];

    const rows = await this.database.db
      .select({
        id: projectDocuments.id,
        filename: projectDocuments.filename,
        textContent: projectDocuments.textContent,
      })
      .from(projectDocuments)
      .where(
        and(
          eq(projectDocuments.projectId, projectId),
          inArray(projectDocuments.id, [...documentIds]),
        ),
      );

    const byId = new Map(rows.map((r) => [r.id, r]));
    return documentIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map((r) => ({ id: r.id, filename: r.filename, content: r.textContent }));
  }
}
