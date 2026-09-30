import webpush from 'web-push';
import { NotificationsService, eventWanted } from './notifications.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AppConfig } from '../../core/config/configuration';

jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(),
  },
}));

const sendNotification = webpush.sendNotification as unknown as jest.Mock;

type Subscription = { id: string; endpoint: string; p256dh: string; auth: string };

/**
 * The dispatcher (ADR-065): who is told, whether they wanted to be, and what
 * happens when a browser is gone.
 *
 * The three per-user lookups (recipients, preferences, subscriptions) are
 * stubbed on the service, and the database stand-in only answers the task
 * join and records writes. Re-implementing drizzle's `where` would test the
 * mock; the assertions here are about routing, preferences and cleanup.
 */
describe('NotificationsService', () => {
  const ADMIN = 'admin-1';
  const CREATOR = 'creator-1';

  const config = (overrides: Partial<AppConfig['push']> = {}) =>
    ({
      push: {
        publicKey: 'BPublicKey',
        privateKey: 'privateKey',
        subject: 'mailto:ops@example.com',
        portalUrl: 'https://cartenz.example.com',
        ...overrides,
      },
    }) as AppConfig;

  const makeDatabase = () => {
    const deleted: unknown[] = [];
    const updated: unknown[] = [];

    const database = {
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: 'task-1',
                    reference: 'task_1',
                    projectId: 'project-1',
                    createdByUserId: CREATOR,
                    projectName: 'Demo',
                  },
                ],
              }),
            }),
          }),
        }),
        update: () => ({
          set: (values: unknown) => ({
            where: async () => {
              updated.push(values);
            },
          }),
        }),
        delete: () => ({
          where: async (condition: unknown) => {
            deleted.push(condition);
          },
        }),
      },
    } as unknown as DatabaseService;

    return { database, deleted, updated };
  };

  interface Scenario {
    recipients: string[];
    preferences?: Record<string, Partial<Record<string, boolean>>>;
    subscriptions: Record<string, Subscription[]>;
  }

  const build = (scenario: Scenario, pushConfig?: Partial<AppConfig['push']>) => {
    const db = makeDatabase();
    const service = new NotificationsService(db.database, config(pushConfig));
    const internals = service as unknown as {
      recipientsFor: (...args: unknown[]) => Promise<{ id: string }[]>;
      subscriptionsFor: (userId: string) => Promise<Subscription[]>;
    };

    const recipientsFor = jest
      .spyOn(internals, 'recipientsFor')
      .mockResolvedValue(scenario.recipients.map((id) => ({ id })));
    jest
      .spyOn(internals, 'subscriptionsFor')
      .mockImplementation(async (userId: string) => scenario.subscriptions[userId] ?? []);
    jest.spyOn(service, 'preferences').mockImplementation(async (userId: string) => ({
      approvalRequired: true,
      taskCompleted: true,
      taskFailed: true,
      soundEnabled: true,
      ...(scenario.preferences?.[userId] ?? {}),
    }));

    return { service, recipientsFor, ...db };
  };

  const sub = (id: string): Subscription => ({
    id,
    endpoint: `https://push.example/${id}`,
    p256dh: 'p',
    auth: 'a',
  });

  beforeEach(() => {
    sendNotification.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201 });
  });

  it('is off, and sends nothing, when the VAPID keys are not configured', async () => {
    const { service } = build(
      { recipients: [CREATOR], subscriptions: { [CREATOR]: [sub('s1')] } },
      { publicKey: '', privateKey: '' },
    );

    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'task_completed',
      message: 'done',
    });

    expect(service.isEnabled).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('ignores progress events', async () => {
    const { service, recipientsFor } = build({
      recipients: [CREATOR],
      subscriptions: { [CREATOR]: [sub('s1')] },
    });

    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'agent_activity',
      message: 'thinking',
    });

    expect(recipientsFor).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('asks for admins on an approval and for the creator on an outcome', async () => {
    const { service, recipientsFor } = build({ recipients: [], subscriptions: {} });

    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'approval_required',
      message: 'x',
    });
    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'task_completed',
      message: 'x',
    });

    expect(recipientsFor).toHaveBeenNthCalledWith(1, 'approval_required', CREATOR);
    expect(recipientsFor).toHaveBeenNthCalledWith(2, 'task_completed', CREATOR);
  });

  it('sends an approval to every subscribed browser of every recipient', async () => {
    const { service } = build({
      recipients: [ADMIN, 'admin-2'],
      subscriptions: { [ADMIN]: [sub('laptop'), sub('phone')], 'admin-2': [sub('other')] },
    });

    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'approval_required',
      message: 'needs approval',
    });

    expect(sendNotification).toHaveBeenCalledTimes(3);
    const payload = JSON.parse(sendNotification.mock.calls[0][1] as string);
    expect(payload.title).toBe('Approval needed');
    expect(payload.url).toBe('https://cartenz.example.com/projects/project-1/agent?task=task-1');
    expect(payload.sound).toBe('approval');
    expect(payload.requireInteraction).toBe(true);
  });

  it('respects a recipient who turned that event off', async () => {
    const { service } = build({
      recipients: [CREATOR],
      preferences: { [CREATOR]: { taskCompleted: false } },
      subscriptions: { [CREATOR]: [sub('s1')] },
    });

    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'task_completed',
      message: 'done',
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends without a sound when the recipient muted it', async () => {
    const { service } = build({
      recipients: [CREATOR],
      preferences: { [CREATOR]: { soundEnabled: false } },
      subscriptions: { [CREATOR]: [sub('s1')] },
    });

    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'task_failed',
      message: 'boom',
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendNotification.mock.calls[0][1] as string).sound).toBeNull();
  });

  it('records a successful delivery', async () => {
    const { service, updated } = build({
      recipients: [CREATOR],
      subscriptions: { [CREATOR]: [sub('s1')] },
    });

    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'task_completed',
      message: 'done',
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]).toHaveProperty('lastSuccessAt');
  });

  it('deletes a subscription the push service reports as gone', async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error('Gone'), { statusCode: 410 }));
    const { service, deleted } = build({
      recipients: [CREATOR],
      subscriptions: { [CREATOR]: [sub('s1')] },
    });

    await service.dispatchForEvent({
      taskId: 'task-1',
      taskReference: 'task_1',
      type: 'task_completed',
      message: 'done',
    });

    expect(deleted).toHaveLength(1);
  });

  it('keeps a subscription on a transient push failure, and never throws', async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error('Busy'), { statusCode: 503 }));
    const { service, deleted } = build({
      recipients: [CREATOR],
      subscriptions: { [CREATOR]: [sub('s1')] },
    });

    await expect(
      service.dispatchForEvent({
        taskId: 'task-1',
        taskReference: 'task_1',
        type: 'task_completed',
        message: 'done',
      }),
    ).resolves.toBeUndefined();
    expect(deleted).toHaveLength(0);
  });

  it('swallows a database failure rather than failing the task', async () => {
    const { service } = build({ recipients: [CREATOR], subscriptions: {} });
    jest
      .spyOn(service as unknown as { recipientsFor: () => Promise<never> }, 'recipientsFor')
      .mockRejectedValue(new Error('connection reset'));

    await expect(
      service.dispatchForEvent({
        taskId: 'task-1',
        taskReference: 'task_1',
        type: 'task_completed',
        message: 'done',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a subscription when push is not configured', async () => {
    const { service } = build(
      { recipients: [], subscriptions: {} },
      { publicKey: '', privateKey: '' },
    );

    await expect(
      service.subscribe(
        'user-1',
        { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } },
        null,
      ),
    ).rejects.toThrow('not configured');
  });
});

describe('eventWanted', () => {
  const all = { approvalRequired: true, taskCompleted: true, taskFailed: true, soundEnabled: true };

  it('maps each event to its own switch', () => {
    expect(eventWanted('approval_required', { ...all, approvalRequired: false })).toBe(false);
    expect(eventWanted('task_completed', { ...all, taskCompleted: false })).toBe(false);
    expect(eventWanted('task_failed', { ...all, taskFailed: false })).toBe(false);
    expect(eventWanted('task_failed', all)).toBe(true);
  });
});
