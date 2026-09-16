import { BadRequestException } from '@nestjs/common';
import { dirname } from 'node:path';
import { OdooVersionsService } from './odoo-versions.service';

/**
 * ADR-045. What matters here is resolution and refusal: which paths a project
 * of a given version ends up using, and that a path which is not on the server
 * is rejected when it is typed rather than at the first task that needs it.
 */
describe('OdooVersionsService', () => {
  const userId = '33333333-3333-4333-8333-333333333333';

  const realDirectory = process.cwd();
  const otherRealDirectory = dirname(process.cwd());

  /** A service whose catalog reads stand in for the database. */
  const serviceWith = (rows: Record<string, unknown>[]) => {
    const service = new OdooVersionsService(
      { db: {} } as never,
      { record: jest.fn() } as never,
    );
    const select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
    });
    (service as unknown as { database: unknown }).database = { db: { select } };
    return service;
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: '44444444-4444-4444-8444-444444444444',
    version: '19.0',
    basePath: '/srv/odoo19',
    enterprisePath: '/srv/enterprise19',
    isActive: true,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  describe('activeFor', () => {
    it('returns the active row for the version', async () => {
      const service = serviceWith([row()]);
      expect(await service.activeFor('19.0')).toEqual({
        basePath: '/srv/odoo19',
        enterprisePath: '/srv/enterprise19',
      });
    });

    it('returns null for a version with no row, or with no version at all', async () => {
      expect(await serviceWith([]).activeFor('18.0')).toBeNull();
      expect(await serviceWith([]).activeFor(null)).toBeNull();
      expect(await serviceWith([]).activeFor(undefined)).toBeNull();
    });

    /** An inactive row is not the answer: the caller falls back to ADR-033 paths. */
    it('treats an inactive row as absent', async () => {
      expect(await serviceWith([row({ isActive: false })]).activeFor('19.0')).toBeNull();
    });
  });

  describe('sourcePathsFor', () => {
    it('gives base + enterprise for an enterprise project', async () => {
      const service = serviceWith([row()]);
      expect(await service.sourcePathsFor('19.0', 'enterprise')).toEqual([
        '/srv/odoo19',
        '/srv/enterprise19',
      ]);
    });

    /**
     * ADR-037 carried into the catalog: a community project is not entitled to
     * enterprise source, whatever the row stores.
     */
    it('drops the enterprise path for a community project', async () => {
      const service = serviceWith([row()]);
      expect(await service.sourcePathsFor('19.0', 'community')).toEqual(['/srv/odoo19']);
    });

    it('returns null when the version has no active row', async () => {
      expect(await serviceWith([]).sourcePathsFor('19.0', 'enterprise')).toBeNull();
    });
  });

  describe('create', () => {
    it('refuses a path that does not exist on the server', async () => {
      const service = serviceWith([]);
      await expect(
        service.create(userId, { version: '19.0', basePath: '/no/such/directory/anywhere' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a relative path', async () => {
      const service = serviceWith([]);
      await expect(
        service.create(userId, { version: '19.0', basePath: 'relative/path' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a file where a directory is required', async () => {
      const service = serviceWith([]);
      await expect(
        service.create(userId, { version: '19.0', basePath: __filename }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /** The version is the catalog key: a second row for it would be ambiguous. */
    it('refuses a duplicate version', async () => {
      const service = serviceWith([row({ basePath: realDirectory })]);
      await expect(
        service.create(userId, { version: '19.0', basePath: realDirectory }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('stores real directories with the enterprise path optional', async () => {
      const service = serviceWith([]);
      const insert = jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([row()]) }),
      });
      const { select } = (service as unknown as { database: { db: { select: unknown } } })
        .database.db;
      (service as unknown as { database: unknown }).database = {
        db: { insert, select },
      };

      await service.create(userId, {
        version: '19.0',
        basePath: realDirectory,
        enterprisePath: otherRealDirectory,
      });

      const values = (insert.mock.results[0].value as { values: jest.Mock }).values.mock
        .calls[0][0];
      expect(values.basePath).toBe(realDirectory);
      expect(values.enterprisePath).toBe(otherRealDirectory);
      expect(values.version).toBe('19.0');
    });
  });
});
