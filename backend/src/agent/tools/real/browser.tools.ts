import { Injectable } from '@nestjs/common';
import { chromium, type Browser, type Page } from 'playwright-core';
import { RedisService } from '../../../core/redis/redis.service';
import { browserSessionKey } from '../../../core/redis/redis.constants';
import {
  ELEMENT_REF,
  MAX_SNAPSHOT_CHARS,
  MAX_TYPE_CHARS,
  agentUrlRefusal,
} from '../../browser/browser-policy';
import type { AnyToolDefinition, ToolDefinition, ToolExecutionContext } from '../tool.interface';

/**
 * The agent's hands in a person's logged-in Odoo Online session (ADR-087,
 * Option B).
 *
 * The session is opened and signed in by a person in the agent workspace (the
 * API's BrowserSessionService); these tools attach to that same Chromium over
 * CDP on 127.0.0.1 for one call and detach. There is no login tool: with no
 * session open, the agent is told to ask the person to sign in.
 *
 * What still holds inside a session: `browser_control` is a separate,
 * default-off permission; every tool is `odoo_online`-only; the agent reaches an
 * element only by a ref from its own latest snapshot; and the users, access,
 * settings and technical screens are refused by URL before and after every
 * action (browser-policy.ts). What does not hold, by construction, is the record
 * surface's deny-list, caps and per-write approval: that is the trade ADR-087
 * records, and why a session is approved once per task and watched live.
 */

interface Attached {
  readonly browser: Browser;
  readonly page: Page;
  readonly host: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refRefusal(input: Record<string, unknown>): string | null {
  return typeof input.ref === 'string' && ELEMENT_REF.test(input.ref)
    ? null
    : 'ref must be an element reference from browser_snapshot, e.g. "e12"';
}

const REF_PARAM = {
  type: 'string',
  description: 'The element reference from your latest browser_snapshot, e.g. "e12".',
  pattern: '^e\\d{1,6}$',
} as const;

@Injectable()
export class BrowserTools {
  constructor(private readonly redis: RedisService) {}

  get definitions(): readonly AnyToolDefinition[] {
    return [this.snapshot, this.click, this.type, this.navigate];
  }

  /**
   * Attaches for one call. The aria refs a snapshot hands out belong to the
   * connection that took it, so every acting tool returns a fresh snapshot and
   * the model always holds refs from the latest one.
   */
  private async withSession<T>(
    context: ToolExecutionContext,
    work: (attached: Attached) => Promise<T>,
  ): Promise<T> {
    const raw = await this.redis.client.get(browserSessionKey(context.projectId));
    if (!raw) {
      throw new Error(
        'No browser session is open for this project. Ask the person to open the Browser panel in ' +
          'the agent workspace and sign in to Odoo, then try again.',
      );
    }
    const { port, host } = JSON.parse(raw) as { port: number; host: string };
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(port)}`, { timeout: 10_000 });
    try {
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error('The browser session has no open page. Ask the person to reopen it.');
      this.assertAllowed(page.url(), host);
      return await work({ browser, page, host });
    } finally {
      // Detaches only: the session and its login belong to the person.
      await browser.close().catch(() => undefined);
    }
  }

  private assertAllowed(url: string, host: string): void {
    const refusal = agentUrlRefusal(url, host);
    if (refusal) throw new Error(`Refused on ${url}: ${refusal}. Navigate to a business screen first.`);
  }

  private async describe(page: Page, host: string): Promise<Record<string, unknown>> {
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    this.assertAllowed(page.url(), host);
    const snapshot = await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
    const truncated = snapshot.length > MAX_SNAPSHOT_CHARS;
    return {
      url: page.url(),
      title: await page.title(),
      snapshot: truncated ? snapshot.slice(0, MAX_SNAPSHOT_CHARS) : snapshot,
      truncated,
    };
  }

  private readonly snapshot: ToolDefinition<Record<string, never>> = {
    name: 'browser_snapshot',
    description: 'Read the Odoo screen in the signed-in browser session',
    permission: 'browser_control',
    modes: ['odoo_online'],
    leavesPlatform: false,
    simulated: false,
    availableToModel: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    validate: (input) => (isPlainObject(input) ? null : 'the input must be an object'),
    execute: (_input, context) => this.withSession(context, ({ page, host }) => this.describe(page, host)),
  };

  private readonly click: ToolDefinition<{ ref: string }> = {
    name: 'browser_click',
    description: 'Click an element in the signed-in Odoo session',
    permission: 'browser_control',
    modes: ['odoo_online'],
    leavesPlatform: true,
    simulated: false,
    availableToModel: true,
    parameters: {
      type: 'object',
      properties: { ref: REF_PARAM },
      required: ['ref'],
      additionalProperties: false,
    },
    validate: (input) => (isPlainObject(input) ? refRefusal(input) : 'the input must be an object'),
    execute: (input, context) =>
      this.withSession(context, async ({ page, host }) => {
        // Refs are per connection: take this connection's snapshot so the ref resolves.
        await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
        await page.locator(`aria-ref=${input.ref}`).click({ timeout: 10_000 });
        return this.describe(page, host);
      }),
  };

  private readonly type: ToolDefinition<{ ref: string; text: string; submit?: boolean }> = {
    name: 'browser_type',
    description: 'Fill a field in the signed-in Odoo session',
    permission: 'browser_control',
    modes: ['odoo_online'],
    leavesPlatform: true,
    simulated: false,
    availableToModel: true,
    parameters: {
      type: 'object',
      properties: {
        ref: REF_PARAM,
        text: { type: 'string', description: 'The value, replacing what the field holds.', maxLength: MAX_TYPE_CHARS },
        submit: { type: 'boolean', description: 'Press Enter afterwards, e.g. to pick an autocomplete match.' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
    validate: (input) => {
      if (!isPlainObject(input)) return 'the input must be an object';
      if (typeof input.text !== 'string' || input.text.length > MAX_TYPE_CHARS) {
        return `text must be a string of at most ${MAX_TYPE_CHARS} characters`;
      }
      return refRefusal(input);
    },
    execute: (input, context) =>
      this.withSession(context, async ({ page, host }) => {
        await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
        const field = page.locator(`aria-ref=${input.ref}`);
        await field.fill(input.text, { timeout: 10_000 });
        if (input.submit) await field.press('Enter', { timeout: 10_000 });
        return this.describe(page, host);
      }),
  };

  private readonly navigate: ToolDefinition<{ url: string }> = {
    name: 'browser_navigate',
    description: 'Open a URL on the project\'s Odoo in the signed-in session',
    permission: 'browser_control',
    modes: ['odoo_online'],
    leavesPlatform: false,
    simulated: false,
    availableToModel: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An https URL on this project\'s own Odoo Online host.', maxLength: 2000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    validate: (input) =>
      isPlainObject(input) && typeof input.url === 'string' && input.url.startsWith('https://')
        ? null
        : 'url must be an https URL on the project\'s Odoo host',
    execute: (input, context) =>
      this.withSession(context, async ({ page, host }) => {
        this.assertAllowed(input.url, host);
        await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return this.describe(page, host);
      }),
  };
}
