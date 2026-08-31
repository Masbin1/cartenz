import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { projectMemory } from '../../core/database/schema';
import { redactMetadata } from '../../core/audit/redact';
import type { ProjectAnalysis } from './odoo-project-analyser';

export interface RecordAnalysisInput {
  readonly projectId: string;
  readonly organizationId: string;
  readonly taskId: string;
  readonly analysis: ProjectAnalysis;
}

/**
 * Persistent project context - the "project memory" of chapter 12.
 *
 * Written by the analysis step so that what the agent knows about a project
 * survives the workspace it was derived from, and so that the portal can show the
 * project's real shape without cloning it again.
 *
 * The contract this class enforces is the one chapter 12 states: project memory
 * holds technical information only. Everything written passes through the audit
 * redaction filter, which is the same control that keeps credentials out of the
 * audit trail. That is a belt-and-braces measure - the analyser reads manifests
 * and file names, so it should never see a credential - but "should never" is not
 * a control.
 */
@Injectable()
export class ProjectMemoryService {
  private readonly logger = new Logger(ProjectMemoryService.name);

  constructor(private readonly database: DatabaseService) {}

  /** Upserts the analysis for a project. One row per project. */
  async record(input: RecordAnalysisInput): Promise<void> {
    const modules = input.analysis.modules.map((module) => ({
      technicalName: module.technicalName,
      name: module.name,
      version: module.version,
      series: module.series,
      path: module.path,
      depends: module.depends.slice(0, 30),
      installable: module.installable,
      isApplication: module.isApplication,
      fileCount: module.fileCount,
    }));

    const structure = {
      addonRoots: input.analysis.structure.addonRoots,
      totalFiles: input.analysis.structure.totalFiles,
      fileCountByExtension: input.analysis.structure.fileCountByExtension,
      truncated: input.analysis.structure.truncated,
    };

    const values = {
      projectId: input.projectId,
      organizationId: input.organizationId,
      detectedOdooVersion: input.analysis.detectedOdooVersion,
      pythonVersion: input.analysis.pythonVersion,
      modules: (redactMetadata({ modules }).modules ?? []) as unknown[],
      repositoryStructure: redactMetadata(structure),
      notes: (redactMetadata({ notes: input.analysis.notes }).notes ?? []) as unknown[],
      updatedByTaskId: input.taskId,
      updatedAt: new Date(),
    };

    await this.database.db
      .insert(projectMemory)
      .values(values)
      .onConflictDoUpdate({ target: projectMemory.projectId, set: values });

    this.logger.log(
      `Project memory updated for ${input.projectId}: Odoo ${input.analysis.detectedOdooVersion ?? 'unknown'}, ${modules.length} module(s)`,
    );
  }

  async findForProject(projectId: string) {
    const [row] = await this.database.db
      .select()
      .from(projectMemory)
      .where(eq(projectMemory.projectId, projectId))
      .limit(1);

    return row ?? null;
  }
}
