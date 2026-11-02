import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projectConnections, projects } from '../../core/database/schema';
import { RedisService } from '../../core/redis/redis.service';
import { browserSessionKey } from '../../core/redis/redis.constants';
import { AuthorizationService } from '../../core/authz/authorization.service';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { hostOf, isAllowedUrl } from '../../agent/browser/browser-policy';
import type { BrowserInputDto } from './browser-input.dto';

/** A session nobody has looked at for this long is closed, with its cookies. */
const IDLE_MS = 30 * 60 * 1000;
/**
 * ponytail: a fixed platform-wide cap, because each session is a Chromium on
 * this host (ADR-087 §Memory). Raise it, or move Chromium to its own host and
 * attach over CDP, when the host has measured room for more.
 */
const MAX_OPEN_SESSIONS = 2;
const VIEWPORT = { width: 1280, height: 800 };

interface Session {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly host: string;
  readonly profileDir: string;
  readonly port: number;
  readonly openedBy: string;
  lastUsed: number;
}

/**
 * The in-portal Odoo Online browser (ADR-087, Option B: login-and-stay).
 *
 * A person opens a Chromium here, signs in to the project's Odoo Online
 * instance themselves, and watches it in the agent workspace while the agent
 * drives it. Cartenz never sees a password at rest: keystrokes pass through to
 * the page and are not stored, and the profile (cookies included) lives in a
 * temporary directory that is deleted when the session closes - on request,
 * after 30 idle minutes, or when this process stops. Nothing survives the
 * person leaving, which is what keeps this from being a new stored secret.
 *
 * Every request the page makes is held to the project's own host and Odoo's
 * sign-in hosts (browser-policy.ts), so this is not a general web proxy.
 */
@Injectable()
export class BrowserSessionService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserSessionService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper = setInterval(() => void this.closeIdle(), 60_000).unref();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly authz: AuthorizationService,
  ) {}

  async status(user: AuthenticatedUser, projectId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId);
    const session = this.sessions.get(projectId);
    return {
      enabled: this.config.browser.enabled,
      open: Boolean(session),
      url: session ? session.page.url() : null,
      agentAllowed: context.agentPermissions.browser_control === true,
    };
  }

  async open(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId);
    if (!this.config.browser.enabled) {
      throw new BadRequestException(
        'The in-portal browser is off on this server (BROWSER_SESSIONS_ENABLED).',
      );
    }
    const existing = this.sessions.get(projectId);
    if (existing) {
      existing.lastUsed = Date.now();
      return this.status(user, projectId);
    }
    if (this.sessions.size >= MAX_OPEN_SESSIONS) {
      throw new ConflictException(
        `${MAX_OPEN_SESSIONS} browser sessions are already open on this server. Close one first.`,
      );
    }

    const startUrl = await this.odooOnlineUrl(projectId);
    const host = hostOf(startUrl);
    if (!host) throw new BadRequestException('The Odoo Online URL must be https.');

    const profileDir = mkdtempSync(join(tmpdir(), 'cartenz-browser-'));
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        viewport: VIEWPORT,
        acceptDownloads: false,
        args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
      });
      // Every request, from the page or from the agent, is held to the project's host.
      await context.route('**/*', (route) =>
        isAllowedUrl(route.request().url(), host) ? route.continue() : route.abort('blockedbyclient'),
      );
      const page = context.pages()[0] ?? (await context.newPage());
      // A popup would be a page nobody is watching; it is closed as it opens.
      context.on('page', (popup) => void popup.close());
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);

      const port = Number(readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      this.sessions.set(projectId, {
        context,
        page,
        host,
        profileDir,
        port,
        openedBy: user.userId,
        lastUsed: Date.now(),
      });
      await this.advertise(projectId);
      this.logger.log(`Browser session opened for project ${projectId} by ${user.userId}`);
    } catch (error) {
      await context?.close().catch(() => undefined);
      rmSync(profileDir, { recursive: true, force: true });
      throw new BadRequestException(`The browser could not start: ${(error as Error).message}`);
    }
    return this.status(user, projectId);
  }

  async screenshot(user: AuthenticatedUser, projectId: string): Promise<Buffer> {
    await this.authz.requireProjectAccess(user, projectId);
    const session = this.require(projectId);
    session.lastUsed = Date.now();
    await this.advertise(projectId);
    return session.page.screenshot({ type: 'jpeg', quality: 60, timeout: 10_000 });
  }

  /** A person's own click or keystroke, forwarded to the page and not recorded. */
  async input(user: AuthenticatedUser, projectId: string, input: BrowserInputDto) {
    await this.authz.requireProjectAccess(user, projectId);
    const session = this.require(projectId);
    session.lastUsed = Date.now();
    const { page } = session;

    switch (input.type) {
      case 'click':
        await page.mouse.click(clamp(input.x, VIEWPORT.width), clamp(input.y, VIEWPORT.height));
        break;
      case 'scroll':
        await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, input.dy ?? 0)));
        break;
      case 'type':
        await page.keyboard.insertText(input.text ?? '');
        break;
      case 'key':
        await page.keyboard.press(input.key ?? '');
        break;
      case 'navigate': {
        const url = input.url ?? '';
        if (!isAllowedUrl(url, session.host)) {
          throw new BadRequestException(`This browser opens only ${session.host}.`);
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
        break;
      }
      case 'back':
        await page.goBack({ timeout: 10_000 }).catch(() => undefined);
        break;
      case 'forward':
        await page.goForward({ timeout: 10_000 }).catch(() => undefined);
        break;
      case 'reload':
        await page.reload({ timeout: 30_000 }).catch(() => undefined);
        break;
    }
    return { url: page.url() };
  }

  async close(user: AuthenticatedUser, projectId: string): Promise<void> {
    await this.authz.requireProjectAccess(user, projectId);
    await this.closeSession(projectId);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  private require(projectId: string): Session {
    const session = this.sessions.get(projectId);
    if (!session) throw new NotFoundException('No browser session is open for this project.');
    return session;
  }

  /** Tells the worker where the session is; expires on its own if this process dies. */
  private async advertise(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) return;
    await this.redis.client.set(
      browserSessionKey(projectId),
      JSON.stringify({ port: session.port, host: session.host }),
      'PX',
      IDLE_MS,
    );
  }

  private async closeSession(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) return;
    this.sessions.delete(projectId);
    await this.redis.client.del(browserSessionKey(projectId)).catch(() => undefined);
    await session.context.close().catch(() => undefined);
    rmSync(session.profileDir, { recursive: true, force: true });
    this.logger.log(`Browser session closed for project ${projectId}`);
  }

  private async closeIdle(): Promise<void> {
    const now = Date.now();
    for (const [projectId, session] of this.sessions) {
      if (now - session.lastUsed > IDLE_MS) await this.closeSession(projectId);
    }
  }

  private async odooOnlineUrl(projectId: string): Promise<string> {
    const [project] = await this.database.db
      .select({ projectType: projects.projectType })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project?.projectType !== 'odoo_online') {
      throw new BadRequestException(
        'The in-portal browser is for Odoo Online projects. Odoo.sh and on-premise projects keep their existing connection.',
      );
    }
    const [connection] = await this.database.db
      .select({ metadata: projectConnections.metadata })
      .from(projectConnections)
      .where(
        and(
          eq(projectConnections.projectId, projectId),
          eq(projectConnections.connectionType, 'odoo_api'),
        ),
      )
      .limit(1);
    const url = connection?.metadata?.url;
    if (typeof url !== 'string' || !url.trim()) {
      throw new BadRequestException('This project has no Odoo Online URL. Add it in the project settings.');
    }
    return url.trim();
  }
}

function clamp(value: number | undefined, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value ?? 0)));
}
