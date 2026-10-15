import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { DatabaseService } from '../../core/database/database.service';
import { mailSettings } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';

/** What the portal shows. The password is never returned, only whether one is held. */
export interface PublicMailSettings {
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly smtpSecure: boolean;
  readonly smtpUser: string | null;
  readonly hasPassword: boolean;
  readonly mailFrom: string | null;
  readonly portalUrl: string | null;
  /** True when no host is saved here, so `SMTP_URL` from the environment applies. */
  readonly smtpFromEnvironment: boolean;
  /** Whether mail goes out at all, from either source. */
  readonly mailEnabled: boolean;
  /** The portal address links use, from either source. */
  readonly effectivePortalUrl: string | null;
}

export interface UpdateMailSettingsInput {
  readonly smtpHost?: string | null;
  readonly smtpPort?: number | null;
  readonly smtpSecure?: boolean;
  readonly smtpUser?: string | null;
  /** Omitted keeps the stored password; an empty string removes it. */
  readonly smtpPassword?: string;
  readonly mailFrom?: string | null;
  readonly portalUrl?: string | null;
}

const DEFAULT_FROM = 'Cartenz <no-reply@linkederp.com>';

/** The portal address, normalised: http(s) only, no trailing slash. */
export function normalisePortalUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BadRequestException('The portal URL must be a full address, like https://cartenz.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException('The portal URL must start with https:// or http://.');
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Outgoing mail settings (ADR-072 addendum).
 *
 * The portal row wins when it names a host; otherwise the environment applies,
 * so a server configured by env keeps working untouched. Read on every send
 * rather than once at startup, so a change in the portal applies without a
 * restart.
 */
@Injectable()
export class MailSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async row() {
    const [row] = await this.database.db.select().from(mailSettings).limit(1);
    return row ?? null;
  }

  /** The transport to send with, or null when mail is off. */
  async transport(): Promise<{ mailer: Transporter; from: string } | null> {
    const row = await this.row();
    const from = row?.mailFrom || this.config.mail.from || DEFAULT_FROM;

    if (row?.smtpHost) {
      const password = row.smtpPasswordRef ? await this.secrets.read(row.smtpPasswordRef) : undefined;
      const mailer = createTransport({
        host: row.smtpHost,
        port: row.smtpPort ?? (row.smtpSecure ? 465 : 587),
        secure: row.smtpSecure,
        ...(row.smtpUser ? { auth: { user: row.smtpUser, pass: password } } : {}),
      });
      return { mailer, from };
    }

    return this.config.mail.smtpUrl
      ? { mailer: createTransport(this.config.mail.smtpUrl), from }
      : null;
  }

  async portalUrl(): Promise<string | null> {
    const row = await this.row();
    return row?.portalUrl || this.config.push.portalUrl;
  }

  async get(): Promise<PublicMailSettings> {
    const row = await this.row();
    const smtpFromEnvironment = !row?.smtpHost;
    return {
      smtpHost: row?.smtpHost ?? null,
      smtpPort: row?.smtpPort ?? null,
      smtpSecure: row?.smtpSecure ?? true,
      smtpUser: row?.smtpUser ?? null,
      hasPassword: Boolean(row?.smtpPasswordRef),
      mailFrom: row?.mailFrom ?? null,
      portalUrl: row?.portalUrl ?? null,
      smtpFromEnvironment,
      mailEnabled: smtpFromEnvironment ? Boolean(this.config.mail.smtpUrl) : true,
      effectivePortalUrl: row?.portalUrl || this.config.push.portalUrl,
    };
  }

  async update(userId: string, input: UpdateMailSettingsInput): Promise<PublicMailSettings> {
    const current = await this.row();
    const blank = (value: string | null | undefined) => value?.trim() || null;

    // A new password is sealed first; the old one is destroyed only after the
    // row points at the new reference, so a failure never leaves the row
    // pointing at nothing.
    let passwordRef = current?.smtpPasswordRef ?? null;
    let retired: string | null = null;
    if (input.smtpPassword !== undefined) {
      retired = passwordRef;
      passwordRef = input.smtpPassword
        ? (await this.secrets.write({ projectId: null, purpose: 'smtp-password', value: input.smtpPassword })).ref
        : null;
    }

    const values = {
      smtpHost: input.smtpHost === undefined ? current?.smtpHost ?? null : blank(input.smtpHost),
      smtpPort: input.smtpPort === undefined ? current?.smtpPort ?? null : input.smtpPort,
      smtpSecure: input.smtpSecure ?? current?.smtpSecure ?? true,
      smtpUser: input.smtpUser === undefined ? current?.smtpUser ?? null : blank(input.smtpUser),
      smtpPasswordRef: passwordRef,
      mailFrom: input.mailFrom === undefined ? current?.mailFrom ?? null : blank(input.mailFrom),
      portalUrl:
        input.portalUrl === undefined ? current?.portalUrl ?? null : normalisePortalUrl(input.portalUrl),
      updatedByUserId: userId,
      updatedAt: new Date(),
    };

    if (current) {
      await this.database.db.update(mailSettings).set(values);
    } else {
      await this.database.db.insert(mailSettings).values(values);
    }
    if (retired) await this.secrets.destroy(retired).catch(() => undefined);

    await this.audit.record({
      event: AUDIT_EVENTS.MAIL_SETTINGS_UPDATED,
      userId,
      metadata: {
        smtpHost: values.smtpHost,
        smtpPort: values.smtpPort,
        smtpUser: values.smtpUser,
        passwordChanged: input.smtpPassword !== undefined,
        mailFrom: values.mailFrom,
        portalUrl: values.portalUrl,
      },
    });

    return this.get();
  }

  /** Sends a test message and reports the server's own error when it fails. */
  async sendTest(to: string): Promise<{ sent: true }> {
    const transport = await this.transport();
    if (!transport) {
      throw new BadRequestException('Mail is off: save an SMTP host here, or set SMTP_URL on the server.');
    }
    try {
      const portal = await this.portalUrl();
      await transport.mailer.sendMail({
        from: transport.from,
        to,
        subject: 'Cartenz test email',
        ...renderMail(portal, {
          name: to,
          intro: 'Mail from Cartenz works. Invitations, sign-up codes and password resets will arrive looking like this one.',
          ...(portal ? { button: { label: 'Open Cartenz', url: portal } } : {}),
          outro: 'You received this because an administrator sent a test from Settings → Email.',
        }),
      });
    } catch (error) {
      throw new BadRequestException(`The SMTP server refused: ${(error as Error).message}`);
    }
    return { sent: true };
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface MailContent {
  readonly name: string;
  readonly intro: string;
  readonly button?: { label: string; url: string };
  /** A one-time code shown large, for typing into the tab the person already has open. */
  readonly code?: string;
  readonly outro: string;
}

/**
 * Every mail Cartenz sends, as HTML with a plain-text twin. Tables and inline
 * styles only, because that is what mail clients render; the logo is served
 * from the portal and the alt text stands in when images are blocked.
 */
export function renderMail(portalUrl: string | null, content: MailContent): { html: string; text: string } {
  const text = [
    `Hello ${content.name},`,
    '',
    content.intro,
    ...(content.code ? ['', `Your code: ${content.code}`] : []),
    ...(content.button ? ['', content.button.url] : []),
    '',
    content.outro,
    '',
    'Cartenz by LinkedERP',
  ].join('\n');

  const logo = portalUrl
    ? `<img src="${escapeHtml(portalUrl)}/brand/lockup-horizontal-1283x343.png" width="150" height="40" alt="Cartenz" style="display:block;border:0;height:40px;width:150px">`
    : '<span style="font-size:20px;font-weight:700;color:#111">Cartenz</span>';
  const button = content.button
    ? `<tr><td style="padding:8px 0 24px"><a href="${escapeHtml(content.button.url)}" style="display:inline-block;background:#dc1a21;color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px">${escapeHtml(content.button.label)}</a></td></tr>`
    : '';
  const code = content.code
    ? `<tr><td style="padding:0 0 24px"><div style="font-size:13px;color:#555;padding-bottom:6px">Or enter this code on the sign-up page:</div><div style="font-family:Menlo,Consolas,monospace;font-size:30px;letter-spacing:8px;font-weight:700;color:#111;background:#f4f4f5;border-radius:8px;padding:12px 16px;display:inline-block">${escapeHtml(content.code)}</div></td></tr>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;padding:32px">
<tr><td style="padding:0 0 28px">${logo}</td></tr>
<tr><td style="font-size:16px;color:#111;padding:0 0 12px">Hello ${escapeHtml(content.name)},</td></tr>
<tr><td style="font-size:15px;line-height:22px;color:#333;padding:0 0 20px">${escapeHtml(content.intro)}</td></tr>
${button}${code}
<tr><td style="font-size:13px;line-height:19px;color:#666;border-top:1px solid #eee;padding:16px 0 0">${escapeHtml(content.outro)}</td></tr>
</table>
<div style="font-size:12px;color:#999;padding-top:16px">Cartenz by LinkedERP</div>
</td></tr></table></body></html>`;

  return { html, text };
}
