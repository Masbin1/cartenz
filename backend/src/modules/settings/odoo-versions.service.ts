import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import {
  odooVersionRepositories,
  type OdooVersionRepositoryRow,
} from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import type { OdooEdition } from '../../core/enums';
import type {
  CreateOdooVersionRepositoryDto,
  UpdateOdooVersionRepositoryDto,
} from './dto/odoo-versions.dto';

/** A catalog row, with whether its paths are actually on the host. */
export interface OdooVersionRepositoryView {
  readonly id: string;
  readonly version: string;
  readonly basePath: string;
  readonly enterprisePath: string | null;
  readonly isActive: boolean;
  readonly description: string | null;
  readonly basePathExists: boolean;
  readonly enterprisePathExists: boolean | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The per-version Odoo source catalog (ADR-045).
 *
 * One row per Odoo series holds the full source checkout for that version —
 * the base repo root and, where entitled, the enterprise addons. Project
 * creation resolves the declared `odooVersion` through this catalog so a
 * generated `odoo.conf` points at the source of the version it claims, and the
 * agent's read-only source paths resolve the same way. The organisation-wide
 * paths (ADR-033) remain the fallback for a version with no active row.
 */
@Injectable()
export class OdooVersionsService {
  private readonly logger = new Logger(OdooVersionsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<OdooVersionRepositoryView[]> {
    const rows = await this.database.db
      .select()
      .from(odooVersionRepositories)
      .orderBy(odooVersionRepositories.version);

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        version: row.version,
        basePath: row.basePath,
        enterprisePath: row.enterprisePath,
        isActive: row.isActive,
        description: row.description,
        basePathExists: await this.exists(row.basePath),
        enterprisePathExists: row.enterprisePath ? await this.exists(row.enterprisePath) : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    );
  }

  /**
   * The active row for a version, or null — the caller falls back to the
   * organisation-wide paths (ADR-033) when this returns nothing.
   */
  async activeFor(version: string | null | undefined): Promise<{
    basePath: string;
    enterprisePath: string | null;
  } | null> {
    if (!version) return null;
    const [row] = await this.database.db
      .select()
      .from(odooVersionRepositories)
      .where(eq(odooVersionRepositories.version, version))
      .limit(1);
    if (!row || !row.isActive) return null;
    return { basePath: row.basePath, enterprisePath: row.enterprisePath };
  }

  /**
   * The source paths a project of the given version and edition reads, from the
   * catalog row alone. Null when the version has no active row.
   *
   * A community project drops the enterprise path even when the catalog row has
   * one (ADR-037): no enterprise licence, no enterprise source.
   */
  async sourcePathsFor(
    version: string | null | undefined,
    edition: OdooEdition,
  ): Promise<readonly string[] | null> {
    const row = await this.activeFor(version);
    if (!row) return null;
    return [row.basePath, edition === 'enterprise' ? row.enterprisePath : null].filter(
      (path): path is string => typeof path === 'string' && path.length > 0,
    );
  }

  async create(
    userId: string,
    input: CreateOdooVersionRepositoryDto,
  ): Promise<OdooVersionRepositoryView> {
    const basePath = this.normalise('basePath', input.basePath);
    const enterprisePath = this.normalise('enterprisePath', input.enterprisePath);
    const description = input.description?.trim() || null;

    if (!basePath) {
      throw new BadRequestException('basePath is required: the checkout holding odoo-bin.');
    }
    await this.assertDirectory('basePath', basePath);
    if (enterprisePath) await this.assertDirectory('enterprisePath', enterprisePath);

    const [existing] = await this.database.db
      .select({ id: odooVersionRepositories.id })
      .from(odooVersionRepositories)
      .where(eq(odooVersionRepositories.version, input.version))
      .limit(1);
    if (existing) {
      throw new BadRequestException(
        `A repository for Odoo ${input.version} is already registered. Edit it rather than ` +
          'adding it twice — the version is the catalog key.',
      );
    }

    const [row] = await this.database.db
      .insert(odooVersionRepositories)
      .values({
        version: input.version,
        basePath,
        enterprisePath,
        description,
        createdByUserId: userId,
      })
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.ODOO_VERSION_REPOSITORY_CREATED,
      userId,
      metadata: { id: row.id, version: input.version, basePath, enterprisePath },
    });

    this.logger.log(`Registered Odoo ${input.version} source: ${basePath}`);
    return this.viewOf(row, await this.exists(basePath), enterprisePath ? await this.exists(enterprisePath) : null);
  }

  async update(
    userId: string,
    rowId: string,
    input: UpdateOdooVersionRepositoryDto,
  ): Promise<OdooVersionRepositoryView> {
    const existing = await this.findById(rowId);
    if (!existing) throw new BadRequestException('No such Odoo version repository.');

    const patch: {
      basePath?: string;
      enterprisePath?: string | null;
      description?: string | null;
      isActive?: boolean;
    } = {};

    if (input.basePath !== undefined) {
      patch.basePath = this.normalise('basePath', input.basePath) ?? undefined;
      if (patch.basePath) await this.assertDirectory('basePath', patch.basePath);
    }
    if (input.enterprisePath !== undefined) {
      patch.enterprisePath = this.normalise('enterprisePath', input.enterprisePath);
      if (patch.enterprisePath) await this.assertDirectory('enterprisePath', patch.enterprisePath);
    }
    if (input.description !== undefined) {
      patch.description = input.description.trim() || null;
    }
    if (input.isActive !== undefined) {
      patch.isActive = input.isActive;
    }

    const [row] = await this.database.db
      .update(odooVersionRepositories)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(odooVersionRepositories.id, rowId))
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.ODOO_VERSION_REPOSITORY_UPDATED,
      userId,
      metadata: { id: rowId, version: row.version, patch },
    });

    return this.viewOf(
      row,
      await this.exists(row.basePath),
      row.enterprisePath ? await this.exists(row.enterprisePath) : null,
    );
  }

  async remove(userId: string, rowId: string): Promise<void> {
    const existing = await this.findById(rowId);
    if (!existing) throw new BadRequestException('No such Odoo version repository.');

    await this.database.db
      .delete(odooVersionRepositories)
      .where(eq(odooVersionRepositories.id, rowId));

    await this.audit.record({
      event: AUDIT_EVENTS.ODOO_VERSION_REPOSITORY_REMOVED,
      userId,
      metadata: { id: rowId, version: existing.version },
    });

    this.logger.log(`Removed Odoo ${existing.version} from the version catalog`);
  }

  private async findById(rowId: string) {
    const [row] = await this.database.db
      .select()
      .from(odooVersionRepositories)
      .where(eq(odooVersionRepositories.id, rowId))
      .limit(1);
    return row ?? null;
  }

  private viewOf(
    row: OdooVersionRepositoryRow,
    basePathExists: boolean,
    enterprisePathExists: boolean | null,
  ): OdooVersionRepositoryView {
    return {
      id: row.id,
      version: row.version,
      basePath: row.basePath,
      enterprisePath: row.enterprisePath,
      isActive: row.isActive,
      description: row.description,
      basePathExists,
      enterprisePathExists,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
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

  private async assertDirectory(field: string, path: string): Promise<void> {
    const info = await stat(path).catch(() => null);
    if (!info) throw new BadRequestException(`${field}: "${path}" does not exist on the server.`);
    if (!info.isDirectory()) {
      throw new BadRequestException(`${field}: "${path}" is not a directory.`);
    }
  }

  private async exists(path: string): Promise<boolean> {
    const info = await stat(path).catch(() => null);
    return info !== null && info.isDirectory();
  }
}
