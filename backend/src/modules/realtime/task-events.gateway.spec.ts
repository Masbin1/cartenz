import { TaskEventsGateway } from './task-events.gateway';

/**
 * Only the scope-filtering logic is unit-testable without a live WebSocket
 * server and Redis connection: `readableProjects`/`deliverToOffice` are
 * private, so this exercises them through the gateway instance with fakes for
 * its three collaborators. The full wire path (connect, subscribe, fan-out)
 * is covered by the manual verification in ADR-066's rollout notes; a fake
 * `ws` socket would test the mock, not the gateway.
 *
 * What this guards: an AI Office subscriber must never receive an event for a
 * task outside the projects `AuthorizationService.readableProjectIds`
 * returned for them. That boundary is the whole reason the feed is scoped
 * per-socket instead of broadcast.
 */
const TASK_ONE = '11111111-1111-4111-8111-111111111111';
const TASK_NINE = '99999999-9999-4999-8999-999999999999';

describe('TaskEventsGateway AI Office scoping', () => {
  function buildGateway(options: {
    isAdmin: boolean;
    readableProjectIds: string[] | null;
    taskProjectId: string;
  }) {
    const redis = {
      subscriber: { psubscribe: jest.fn(), on: jest.fn() },
    };
    const tokens = {};
    const database = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ projectId: options.taskProjectId }],
            }),
          }),
        }),
      },
    };
    const authz = {
      readableProjectIds: jest.fn(async () => options.readableProjectIds),
    };

    const gateway = new TaskEventsGateway(
      redis as never,
      tokens as never,
      database as never,
      authz as never,
    );

    return gateway;
  }

  function fakeSocket() {
    return { readyState: 1, send: jest.fn() } as unknown as import('ws').WebSocket;
  }

  it('delivers an event to an office subscriber whose scope includes the task project', async () => {
    const gateway = buildGateway({
      isAdmin: false,
      readableProjectIds: ['project-a', 'project-b'],
      taskProjectId: 'project-a',
    });
    const socket = fakeSocket();
    const subscriber = {
      socket,
      user: { userId: 'u1', isAdmin: false } as never,
      taskIds: new Set<string>(),
      office: true,
      scopes: null,
      scopeAt: 0,
      access: new Map(),
    };

    await (gateway as unknown as { deliverToOffice: Function }).deliverToOffice(
      subscriber,
      TASK_ONE,
      '{"type":"tool_started"}',
    );

    expect(socket.send).toHaveBeenCalledWith('{"type":"tool_started"}');
  });

  it('withholds an event whose task project is outside the subscriber scope', async () => {
    const gateway = buildGateway({
      isAdmin: false,
      readableProjectIds: ['project-b'],
      taskProjectId: 'project-a',
    });
    const socket = fakeSocket();
    const subscriber = {
      socket,
      user: { userId: 'u1', isAdmin: false } as never,
      taskIds: new Set<string>(),
      office: true,
      scopes: null,
      scopeAt: 0,
      access: new Map(),
    };

    await (gateway as unknown as { deliverToOffice: Function }).deliverToOffice(
      subscriber,
      TASK_ONE,
      '{"type":"tool_started"}',
    );

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('lets an admin subscriber receive every task regardless of project', async () => {
    const gateway = buildGateway({
      isAdmin: true,
      readableProjectIds: null,
      taskProjectId: 'project-z',
    });
    const socket = fakeSocket();
    const subscriber = {
      socket,
      user: { userId: 'admin', isAdmin: true } as never,
      taskIds: new Set<string>(),
      office: true,
      scopes: null,
      scopeAt: 0,
      access: new Map(),
    };

    await (gateway as unknown as { deliverToOffice: Function }).deliverToOffice(
      subscriber,
      TASK_NINE,
      '{"type":"tool_started"}',
    );

    expect(socket.send).toHaveBeenCalledWith('{"type":"tool_started"}');
  });

  it('caches a denial so a repeated event for the same task is not re-checked', async () => {
    const gateway = buildGateway({
      isAdmin: false,
      readableProjectIds: ['project-b'],
      taskProjectId: 'project-a',
    });
    const authz = (gateway as unknown as { authz: { readableProjectIds: jest.Mock } }).authz;
    const socket = fakeSocket();
    const subscriber = {
      socket,
      user: { userId: 'u1', isAdmin: false } as never,
      taskIds: new Set<string>(),
      office: true,
      scopes: null,
      scopeAt: 0,
      access: new Map(),
    };

    await (gateway as unknown as { deliverToOffice: Function }).deliverToOffice(
      subscriber,
      TASK_ONE,
      '{}',
    );
    await (gateway as unknown as { deliverToOffice: Function }).deliverToOffice(
      subscriber,
      TASK_ONE,
      '{}',
    );

    expect(authz.readableProjectIds).toHaveBeenCalledTimes(1);
    expect(socket.send).not.toHaveBeenCalled();
  });
});
