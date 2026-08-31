import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocket, WebSocketServer as WsServer } from 'ws';
import type { Server } from 'node:http';
import { RedisService } from '../../core/redis/redis.service';
import {
  TASK_EVENT_CHANNEL_PATTERN,
  taskIdFromChannel,
} from '../../core/redis/redis.constants';
import { TokenService } from '../auth/token.service';
import { DatabaseService } from '../../core/database/database.service';
import { agentTasks } from '../../core/database/schema';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { eq } from 'drizzle-orm';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/** A connected client and the tasks it is following. */
interface Subscriber {
  readonly socket: WebSocket;
  readonly user: AuthenticatedUser;
  readonly taskIds: Set<string>;
}

/**
 * WebSocket relay for task events (chapter 9).
 *
 * The worker publishes to Redis; this gateway subscribes once with a pattern and
 * fans out to connected clients. One pattern subscription serves every client,
 * rather than a subscription per task, which is what keeps the Redis connection
 * count independent of the number of open browser tabs.
 *
 * Two properties are load-bearing:
 *
 *  1. A socket is authenticated before it is registered. The access token is
 *     verified on connect and the connection is closed if it is absent or
 *     invalid, so an unauthenticated socket never enters the subscriber set.
 *  2. A subscription to a task is authorised against the project. Receiving
 *     another organisation's events would defeat the isolation the whole
 *     platform rests on, so the check is the same AuthorizationService the HTTP
 *     layer uses.
 */
@Injectable()
export class TaskEventsGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskEventsGateway.name);
  private server?: WsServer;
  private readonly subscribers = new Map<WebSocket, Subscriber>();

  constructor(
    private readonly redis: RedisService,
    private readonly tokens: TokenService,
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.redis.subscriber.psubscribe(TASK_EVENT_CHANNEL_PATTERN);

    this.redis.subscriber.on('pmessage', (_pattern, channel, message) => {
      const taskId = taskIdFromChannel(channel);
      if (!taskId) return;
      this.fanOut(taskId, message);
    });

    this.logger.log(`Subscribed to ${TASK_EVENT_CHANNEL_PATTERN}`);
  }

  /**
   * Attaches the WebSocket server to the HTTP server. Called from the bootstrap
   * so that the API and the socket share one port and one reverse-proxy route.
   */
  attach(httpServer: Server, path = '/ws'): void {
    this.server = new WsServer({ server: httpServer, path });

    this.server.on('connection', (socket, request) => {
      void this.onConnection(socket, request.url ?? '');
    });

    this.logger.log(`WebSocket endpoint listening on ${path}`);
  }

  private async onConnection(socket: WebSocket, url: string): Promise<void> {
    const token = new URL(url, 'http://localhost').searchParams.get('token');

    if (!token) {
      socket.close(4401, 'An access token is required');
      return;
    }

    let user: AuthenticatedUser;
    try {
      const claims = await this.tokens.verifyAccessToken(token);
      user = { userId: claims.sub, email: claims.email, name: claims.name };
    } catch {
      socket.close(4401, 'The access token is invalid or has expired');
      return;
    }

    this.subscribers.set(socket, { socket, user, taskIds: new Set() });

    socket.on('message', (raw) => {
      void this.onMessage(socket, raw.toString());
    });
    socket.on('close', () => this.subscribers.delete(socket));
    socket.on('error', () => this.subscribers.delete(socket));

    this.send(socket, { type: 'connected', userId: user.userId });
  }

  private async onMessage(socket: WebSocket, raw: string): Promise<void> {
    const subscriber = this.subscribers.get(socket);
    if (!subscriber) return;

    let message: { action?: string; taskId?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      this.send(socket, { type: 'error', message: 'Malformed message' });
      return;
    }

    if (message.action === 'subscribe' && typeof message.taskId === 'string') {
      const authorised = await this.mayFollowTask(subscriber.user, message.taskId);
      if (!authorised) {
        this.send(socket, {
          type: 'error',
          message: 'You do not have access to that task',
          taskId: message.taskId,
        });
        return;
      }
      subscriber.taskIds.add(message.taskId);
      this.send(socket, { type: 'subscribed', taskId: message.taskId });
      return;
    }

    if (message.action === 'unsubscribe' && typeof message.taskId === 'string') {
      subscriber.taskIds.delete(message.taskId);
      this.send(socket, { type: 'unsubscribed', taskId: message.taskId });
      return;
    }

    if (message.action === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }

    this.send(socket, { type: 'error', message: 'Unsupported action' });
  }

  /**
   * Whether a user may follow a task, decided through the same authorisation
   * service the HTTP layer uses. A denial is not distinguished from a missing
   * task, so a socket cannot be used to probe for task identifiers.
   */
  private async mayFollowTask(user: AuthenticatedUser, taskId: string): Promise<boolean> {
    if (!isUuid(taskId)) return false;

    const [task] = await this.database.db
      .select({ projectId: agentTasks.projectId })
      .from(agentTasks)
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    if (!task) return false;

    try {
      await this.authz.requireProjectAccess(user, task.projectId);
      return true;
    } catch {
      return false;
    }
  }

  private fanOut(taskId: string, payload: string): void {
    for (const subscriber of this.subscribers.values()) {
      if (!subscriber.taskIds.has(taskId)) continue;
      if (subscriber.socket.readyState !== WebSocket.OPEN) continue;
      subscriber.socket.send(payload);
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const subscriber of this.subscribers.values()) {
      subscriber.socket.close(1001, 'Server shutting down');
    }
    this.subscribers.clear();
    this.server?.close();
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
