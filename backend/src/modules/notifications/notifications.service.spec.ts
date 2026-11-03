import webpush from 'web-push';
import type { MailSettingsService } from '../settings/mail-settings.service';
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
    const resolved = config(pushConfig);
    // The portal URL now comes from mail settings; this stand-in returns the configured one.
    const mailSettings = { portalUrl: async () => resolved.push.portalUrl } as unknown as MailSettingsService;
    const service = new NotificationsService(db.database, resolved, mailSettings);
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

  it('asks for the creator on both an approval and an outcome', async () => {
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

    expect(recipientsFor).toHaveBeenNthCalledWith(1, CREATOR);
    expect(recipientsFor).toHaveBeenNthCalledWith(2, CREATOR);
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

/**
 * ADR-089: a push for any event - approval included - goes only to the task's
 * creator, never to every admin. This exercises `recipientsFor` itself
 * (unmocked, unlike the suite above) against a users table that mixes admins
 * and non-admins, so a regression that reaches back into `isAdmin` is caught
 * here even though the suite above mocks `recipientsFor` away.
 */
describe('NotificationsService.recipientsFor (ADR-089)', () => {
  const ADMIN_NOT_CREATOR = 'admin-not-creator';
  const CREATOR_NOT_ADMIN = 'creator-not-admin';

  const userRows: Record<string, { id: string; isAdmin: boolean; isActive: boolean }> = {
    [ADMIN_NOT_CREATOR]: { id: ADMIN_NOT_CREATOR, isAdmin: true, isActive: true },
    [CREATOR_NOT_ADMIN]: { id: CREATOR_NOT_ADMIN, isAdmin: false, isActive: true },
  };

  const buildService = () => {
    const database = {
      db: {
        // Only ever reached through recipientsFor's own select().from(users).where(...)
        // in this describe block, so a fixed, filtered-by-id answer is enough.
        select: () => ({
          from: () => ({
            where: (condition: unknown) => {
              // drizzle's eq()/and() build a queryChunks tree with circular
              // references back to the table definition (JSON.stringify
              // throws on it), so the bound value is found by a manual,
              // cycle-guarded walk instead of serialising the whole tree.
              const matchedId = Object.keys(userRows).find((id) => containsString(condition, id));
              const row = matchedId ? userRows[matchedId] : undefined;
              return Promise.resolve(row ? [{ id: row.id }] : []);
            },
          }),
        }),
      },
    } as unknown as DatabaseService;

    const resolved = {
      push: {
        publicKey: 'BPublicKey',
        privateKey: 'privateKey',
        subject: 'mailto:ops@example.com',
        portalUrl: 'https://cartenz.example.com',
      },
    } as AppConfig;
    const mailSettings = { portalUrl: async () => resolved.push.portalUrl } as unknown as MailSettingsService;
    const service = new NotificationsService(database, resolved, mailSettings);
    return service as unknown as {
      recipientsFor: (createdByUserId: string | null) => Promise<{ id: string }[]>;
    };
  };

  it('returns the creator even when they are not an admin', async () => {
    const service = buildService();
    const recipients = await service.recipientsFor(CREATOR_NOT_ADMIN);
    expect(recipients).toEqual([{ id: CREATOR_NOT_ADMIN }]);
  });

  it('never returns an admin who is not the creator', async () => {
    const service = buildService();
    const recipients = await service.recipientsFor(CREATOR_NOT_ADMIN);
    expect(recipients.map((r) => r.id)).not.toContain(ADMIN_NOT_CREATOR);
  });

  it('returns nothing for a task with no creator', async () => {
    const service = buildService();
    expect(await service.recipientsFor(null)).toEqual([]);
  });
});

/**
 * Finds `needle` as a string value reachable from `value`, walking plain
 * objects and arrays with a `seen` set to stop at a cycle - drizzle's query
 * tree links back to its table definition, which `JSON.stringify` cannot
 * walk at all.
 */
function containsString(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value === needle;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return entries.some((entry) => containsString(entry, needle, seen));
}
