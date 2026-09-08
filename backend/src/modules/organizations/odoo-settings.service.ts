import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { organizationOdooSettings } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import type { OdooEdition } from '../../core/enums';

/** A configured path, and whether it is actually there. */
export interface OdooPathStatus {
  readonly path: string | null;
  /** Null when no path is set; otherwise whether it exists and is a directory. */
  readonly exists: boolean | null;
}

export interface PublicOdooSettings {
  readonly basePath: OdooPathStatus;
  readonly enterprisePath: OdooPathStatus;
  readonly projectsRoot: OdooPathStatus;
  /**
   * True when no row exists and the deployment's environment configuration is
   * what the agent is using (ADR-031). Shown so the portal does not present an
   * empty form as though nothing were configured.
   */
  readonly fromEnvironment: boolean;
  /** The paths in force, whatever their source. */
  readonly effectiveSourcePaths: readonly string[];
}

export interface UpdateOdooSettingsInput {
  readonly basePath?: string | null;
  readonly enterprisePath?: string | null;
  readonly projectsRoot?: string | null;
}

/**
 * Where an organisation's Odoo estate lives (ADR-033).
 *
 * Read by the workspace layer to decide what the agent may read, and by project
 * creation to decide where a new project's directory goes. The environment is
 * the fallback rather than the authority: a deployment that configured
 * ODOO_SOURCE_PATHS keeps working, and one that fills in the portal stops
 * depending on its .env.
 */
@Injectable()
export class OdooSettingsService {
  private readonly logger = new Logger(OdooSettingsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The stored row, or null when the organisation has never configured one. */
  async findRow(organizationId: string) {
    const [row] = await this.database.db
      .select()
      .from(organizationOdooSettings)
      .where(eq(organizationOdooSettings.organizationId, organizationId))
      .limit(1);
    return row ?? null;
  }

  /**
   * The read-only Odoo source paths in force for an organisation.
   *
   * The stored base and enterprise paths when set, otherwise the deployment's
   * configuration (ADR-031). Empty means no reference, in which case every read
   * resolves inside the workspace.
   *
   * `edition` (ADR-037): a community project drops the stored enterprise path, so
   * the agent cannot read enterprise source it is not entitled to. Omitted means
   * enterprise — every existing caller keeps the full set. The exclusion applies
   * only to the portal-configured enterprise path, which is the identifiable one;
   * the environment fallback (ADR-031) is a flat, unlabelled list and is left as
   * configured, so a deployment that wants the narrower behaviour sets the paths
   * in the portal.
   */
  async sourcePathsFor(
    organizationId: string,
    edition: OdooEdition = 'enterprise',
  ): Promise<readonly string[]> {
    const row = await this.findRow(organizationId);
    const enterprisePath = edition === 'community' ? null : row?.enterprisePath;
    const configured = [row?.basePath, enterprisePath].filter(
      (path): path is string => typeof path === 'string' && path.length > 0,
    );
    return configured.length > 0 ? configured : this.config.odooSource?.paths ?? [];
  }

  /**
   * Where a new project's directory is created.
   *
   * The stored projects root when set, otherwise ON_PREMISE_ROOT. Null when
   * neither is configured, which project creation reports rather than defaulting
   * to a platform directory.
   */
  async projectsRootFor(organizationId: string): Promise<string | null> {
    const row = await this.findRow(organizationId);
    return row?.projectsRoot || this.config.onPremise.root || null;
  }

  async get(organizationId: string): Promise<PublicOdooSettings> {
    const row = await this.findRow(organizationId);
    const fallbackRoot = this.config.onPremise.root ?? null;

    const basePath = row?.basePath ?? null;
    const enterprisePath = row?.enterprisePath ?? null;
    const projectsRoot = row?.projectsRoot ?? fallbackRoot;

    return {
      basePath: await this.describe(basePath),
      enterprisePath: await this.describe(enterprisePath),
      projectsRoot: await this.describe(projectsRoot),
      fromEnvironment: !row || (!row.basePath && !row.enterprisePath),
      effectiveSourcePaths: await this.sourcePathsFor(organizationId),
    };
  }

  async update(
    organizationId: string,
    userId: string,
    input: UpdateOdooSettingsInput,
  ): Promise<PublicOdooSettings> {
    const basePath = this.normalise('basePath', input.basePath);
    const enterprisePath = this.normalise('enterprisePath', input.enterprisePath);
    const projectsRoot = this.normalise('projectsRoot', input.projectsRoot);

    /**
     * A path that does not exist is refused rather than stored.
     *
     * Storing it would move the failure to the first task that needs it, where
     * the message is about a workspace rather than about the setting the person
     * just typed.
     */
    for (const [field, path] of [
      ['basePath', basePath],
      ['enterprisePath', enterprisePath],
      ['projectsRoot', projectsRoot],
    ] as const) {
      if (!path) continue;
      const info = await stat(path).catch(() => null);
      if (!info) throw new BadRequestException(`${field}: "${path}" does not exist on the server.`);
      if (!info.isDirectory()) {
        throw new BadRequestException(`${field}: "${path}" is not a directory.`);
      }
    }

    await this.database.db
      .insert(organizationOdooSettings)
      .values({
        organizationId,
        basePath,
        enterprisePath,
        projectsRoot,
        updatedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: organizationOdooSettings.organizationId,
        set: {
          basePath,
          enterprisePath,
          projectsRoot,
          updatedByUserId: userId,
          updatedAt: new Date(),
        },
      });

    await this.audit.record({
      event: AUDIT_EVENTS.ODOO_SETTINGS_UPDATED,
      organizationId,
      userId,
      metadata: { basePath, enterprisePath, projectsRoot },
    });

    this.logger.log(
      `Odoo settings updated for organisation ${organizationId}: base=${basePath ?? '-'}, enterprise=${enterprisePath ?? '-'}, projects=${projectsRoot ?? '-'}`,
    );

    return this.get(organizationId);
  }

  /** Trims, treats blank as cleared, and requires an absolute path. */
  private normalise(field: string, value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (!isAbsolute(trimmed)) {
      throw new BadRequestException(`${field}: "${trimmed}" must be an absolute path.`);
    }
    return trimmed;
  }

  private async describe(path: string | null): Promise<OdooPathStatus> {
    if (!path) return { path: null, exists: null };
    const info = await stat(path).catch(() => null);
    return { path, exists: info !== null && info.isDirectory() };
  }
}
