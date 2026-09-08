import { BadRequestException } from '@nestjs/common';
import { OdooSettingsService } from './odoo-settings.service';

/**
 * ADR-033. What matters here is precedence and refusal: which paths the agent
 * ends up reading, and that a path which is not on the server is rejected when
 * it is typed rather than at the first task that needs it.
 */
describe('OdooSettingsService', () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';

  // Two directories that certainly exist, used as stand-ins for a real estate.
  const realDirectory = process.cwd();
  const otherRealDirectory = require('node:path').dirname(process.cwd());

  const config = {
    odooSource: { paths: ['/env/odoo', '/env/enterprise'] },
    onPremise: { root: '/env/root', readOnlyPaths: [] },
  } as never;

  /** Stands in for the row the service reads; `null` means never configured. */
  const serviceWith = (row: Record<string, unknown> | null) => {
    const service = new OdooSettingsService(
      {} as never,
      { record: jest.fn() } as never,
      config,
    );
    jest.spyOn(service, 'findRow').mockResolvedValue(row as never);
    return service;
  };

  describe('sourcePathsFor', () => {
    it('uses the environment when the organisation has never configured paths', async () => {
      const service = serviceWith(null);
      expect(await service.sourcePathsFor(organizationId)).toEqual([
        '/env/odoo',
        '/env/enterprise',
      ]);
    });

    /**
     * The portal is the authority once it is filled in — otherwise configuring
     * it would appear to work while the agent kept reading the old estate.
     */
    it('prefers the configured paths over the environment', async () => {
      const service = serviceWith({
        basePath: '/srv/odoo',
        enterprisePath: '/srv/enterprise',
      });
      expect(await service.sourcePathsFor(organizationId)).toEqual([
        '/srv/odoo',
        '/srv/enterprise',
      ]);
    });

    it('keeps a base path configured without an enterprise one', async () => {
      const service = serviceWith({ basePath: '/srv/odoo', enterprisePath: null });
      expect(await service.sourcePathsFor(organizationId)).toEqual(['/srv/odoo']);
    });

    it('falls back when a row exists but sets no source path', async () => {
      const service = serviceWith({ basePath: null, enterprisePath: null, projectsRoot: '/p' });
      expect(await service.sourcePathsFor(organizationId)).toEqual([
        '/env/odoo',
        '/env/enterprise',
      ]);
    });

    /**
     * ADR-037: a community project has no enterprise licence, so the agent must
     * not be given the enterprise source to read.
     */
    it('excludes the configured enterprise path for a community project', async () => {
      const service = serviceWith({
        basePath: '/srv/odoo',
        enterprisePath: '/srv/enterprise',
      });
      expect(await service.sourcePathsFor(organizationId, 'community')).toEqual(['/srv/odoo']);
    });

    it('keeps the enterprise path for an enterprise project', async () => {
      const service = serviceWith({
        basePath: '/srv/odoo',
        enterprisePath: '/srv/enterprise',
      });
      expect(await service.sourcePathsFor(organizationId, 'enterprise')).toEqual([
        '/srv/odoo',
        '/srv/enterprise',
      ]);
    });
  });

  describe('projectsRootFor', () => {
    it('prefers the configured root, falling back to ON_PREMISE_ROOT', async () => {
      expect(await serviceWith({ projectsRoot: '/srv/projects' }).projectsRootFor(organizationId))
        .toBe('/srv/projects');
      expect(await serviceWith(null).projectsRootFor(organizationId)).toBe('/env/root');
    });
  });

  describe('update', () => {
    /**
     * Storing a path that is not there moves the failure to the first task,
     * where the message is about a workspace rather than about the setting the
     * person just typed.
     */
    it('refuses a path that does not exist on the server', async () => {
      const service = serviceWith(null);
      await expect(
        service.update(organizationId, userId, { basePath: '/no/such/directory/anywhere' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a relative path', async () => {
      const service = serviceWith(null);
      await expect(
        service.update(organizationId, userId, { basePath: 'relative/path' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a file where a directory is required', async () => {
      const service = serviceWith(null);
      await expect(
        service.update(organizationId, userId, { basePath: __filename }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * A blank field clears the setting rather than being stored, so a PUT of the
     * whole form can remove a path the same way it sets one.
     */
    it('accepts real directories and treats blank as cleared', async () => {
      const service = serviceWith(null);
      const insert = jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) }),
      });
      (service as unknown as { database: unknown }).database = { db: { insert } };
      jest.spyOn(service, 'get').mockResolvedValue({} as never);

      await service.update(organizationId, userId, {
        basePath: realDirectory,
        enterprisePath: otherRealDirectory,
        projectsRoot: '   ',
      });

      const values = insert.mock.results[0].value.values.mock.calls[0][0];
      expect(values.basePath).toBe(realDirectory);
      expect(values.enterprisePath).toBe(otherRealDirectory);
      expect(values.projectsRoot).toBeNull();
    });
  });
});
