import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createTransport, type Transporter } from 'nodemailer';
import { DatabaseService } from '../../core/database/database.service';
import { userTokens, users } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export type LinkPurpose = 'invite' | 'reset';

/** How long each kind of link stays usable. */
export const LINK_TTL_MS: Record<LinkPurpose, number> = {
  invite: 72 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

export const hashLinkToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The portal path a link opens. Both land on the same set-password page. */
export function linkUrl(portalUrl: string, purpose: LinkPurpose, token: string): string {
  return `${portalUrl}/set-password?purpose=${purpose}&token=${encodeURIComponent(token)}`;
}

/**
 * Invitation and password-reset links (ADR-072).
 *
 * A link is a random token, stored only as its hash, used once, and expiring.
 * Mail is the delivery, not the mechanism: with `SMTP_URL` unset the link is
 * still issued and returned to the admin who asked, so a mail outage never locks
 * anyone out of the platform.
 */
@Injectable()
export class UserLinksService {
  private readonly logger = new Logger(UserLinksService.name);
  private readonly mailer: Transporter | null;

  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.mailer = config.mail.smtpUrl ? createTransport(config.mail.smtpUrl) : null;
  }

  get mailEnabled(): boolean {
    return this.mailer !== null;
  }

  /**
   * Issues a link and mails it when mail is on. Earlier unused links of the same
   * purpose are invalidated, so only the newest one in someone's inbox works.
   * Returns the URL so an admin can hand it over when mail is off or delayed.
   */
  async issue(
    user: { id: string; email: string; name: string },
    purpose: LinkPurpose,
  ): Promise<{ url: string; mailed: boolean }> {
    const token = randomBytes(32).toString('base64url');

    await this.database.transaction(async (tx) => {
      await tx
        .update(userTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(userTokens.userId, user.id),
            eq(userTokens.purpose, purpose),
            isNull(userTokens.usedAt),
          ),
        );
      await tx.insert(userTokens).values({
        userId: user.id,
        purpose,
        tokenHash: hashLinkToken(token),
        expiresAt: new Date(Date.now() + LINK_TTL_MS[purpose]),
      });
    });

    const url = linkUrl(this.portalUrl(), purpose, token);
    return { url, mailed: await this.send(user, purpose, url) };
  }

  /**
   * Answers the public "forgot password" form. Always resolves the same way,
   * whether or not the address has an account, so the form cannot be used to
   * find out which addresses are registered.
   */
  async requestReset(email: string, ipAddress: string | null): Promise<void> {
    const [user] = await this.database.db
      .select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);

    await this.audit.record({
      event: AUDIT_EVENTS.USER_RESET_REQUESTED,
      userId: user?.id ?? null,
      ipAddress,
      metadata: { email, matched: Boolean(user?.isActive), mailEnabled: this.mailEnabled },
    });

    if (!user?.isActive || !this.mailer) return;

    // ponytail: one recent reset per account stands in for a rate limiter; add
    // a per-IP throttle if the form is ever abused across many addresses.
    const [recent] = await this.database.db
      .select({ id: userTokens.id })
      .from(userTokens)
      .where(
        and(
          eq(userTokens.userId, user.id),
          eq(userTokens.purpose, 'reset'),
          gt(userTokens.createdAt, new Date(Date.now() - 2 * 60 * 1000)),
        ),
      )
      .limit(1);
    if (recent) return;

    await this.issue(user, 'reset');
  }

  /**
   * Sets a password from a link. The token is consumed in the same statement
   * that checks it, so two submissions of one link cannot both succeed. Every
   * session of the account is revoked: whoever held the old password is out.
   */
  async redeem(token: string, newPassword: string, ipAddress: string | null): Promise<void> {
    const [consumed] = await this.database.db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userTokens.tokenHash, hashLinkToken(token)),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: userTokens.userId, purpose: userTokens.purpose });

    if (!consumed) {
      throw new BadRequestException(
        'This link is invalid, has expired or was already used. Ask for a new one.',
      );
    }

    await this.database.db
      .update(users)
      .set({ passwordHash: await this.passwords.hash(newPassword), updatedAt: new Date() })
      .where(eq(users.id, consumed.userId));
    await this.tokens.revokeAllForUser(consumed.userId);

    await this.audit.record({
      event: AUDIT_EVENTS.USER_LINK_REDEEMED,
      userId: consumed.userId,
      ipAddress,
      metadata: { purpose: consumed.purpose },
    });
  }

  private portalUrl(): string {
    const url = this.config.push.portalUrl;
    if (!url) {
      throw new BadRequestException(
        'PORTAL_PUBLIC_URL is not set, so a link back to the portal cannot be built.',
      );
    }
    return url;
  }

  /** False when mail is off or the send failed; the link itself is still valid. */
  private async send(
    user: { email: string; name: string },
    purpose: LinkPurpose,
    url: string,
  ): Promise<boolean> {
    if (!this.mailer) return false;

    const invite = purpose === 'invite';
    const subject = invite ? 'You are invited to Cartenz' : 'Reset your Cartenz password';
    const text = [
      `Hello ${user.name},`,
      '',
      invite
        ? 'An account was created for you on Cartenz. Choose a password to start:'
        : 'Somebody asked to reset the password for this account. If it was you, choose a new one:',
      '',
      url,
      '',
      invite
        ? 'The link works once and expires in 72 hours.'
        : 'The link works once and expires in 1 hour. If you did not ask, ignore this email; your password stays as it is.',
    ].join('\n');

    try {
      await this.mailer.sendMail({ from: this.config.mail.from, to: user.email, subject, text });
      return true;
    } catch (error) {
      // The address is not logged: it is personal data, and the audit row has it.
      this.logger.error(`Mail for a ${purpose} link failed: ${(error as Error).message}`);
      return false;
    }
  }
}
