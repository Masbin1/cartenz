import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { ModelSettingsService } from './model-settings.service';
import { ModelProviderResolver } from '../../agent/model/model-provider-resolver';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { AUTH_USER_KEY } from '../../core/http/current-user.decorator';
import type { AuthenticatedRequest } from '../../core/http/current-user.decorator';

/**
 * Nest matches routes in declaration order, so a literal path declared after a
 * parameterised sibling is unreachable: `PATCH .../order` binds rowId to the
 * string "order" and answers 200 from the wrong handler rather than 404ing.
 *
 * That failure is invisible to a unit test of the service and to a typecheck of
 * the client, which is why it is asserted here, against the real decorators.
 */
describe('model provider route matching', () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const rowId = '22222222-2222-4222-8222-222222222222';

  let app: INestApplication;
  const reorder = jest.fn(async () => ({ rows: [], fromEnvironment: false, environmentSummary: null }));
  const updateRow = jest.fn(async () => ({ id: rowId }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        { provide: OrganizationsService, useValue: {} },
        { provide: ModelSettingsService, useValue: { reorder, updateRow } },
        { provide: ModelProviderResolver, useValue: { invalidate: jest.fn() } },
        { provide: AuthorizationService, useValue: { requireOrganizationMember: jest.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Stands in for JwtAuthGuard: @CurrentUser throws without an attached
    // identity, and what is under test here is which handler a path reaches.
    app.use((req: AuthenticatedRequest, _res: unknown, next: () => void) => {
      req[AUTH_USER_KEY] = {
        userId: '33333333-3333-4333-8333-333333333333',
        email: 'admin@example.com',
      } as never;
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    reorder.mockClear();
    updateRow.mockClear();
  });

  it('sends PATCH .../order to reorder rather than to the row update', async () => {
    await request(app.getHttpServer())
      .patch(`/organizations/${organizationId}/model-providers/order`)
      .send({ order: [rowId] })
      .expect(200);

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(updateRow).not.toHaveBeenCalled();
  });

  it('still sends PATCH .../<uuid> to the row update', async () => {
    await request(app.getHttpServer())
      .patch(`/organizations/${organizationId}/model-providers/${rowId}`)
      .send({ label: 'renamed' })
      .expect(200);

    expect(updateRow).toHaveBeenCalledTimes(1);
    expect(reorder).not.toHaveBeenCalled();
  });
});
