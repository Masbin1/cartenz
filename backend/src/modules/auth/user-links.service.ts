import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { userTokens, users } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { MailSettingsService, renderMail } from '../settings/mail-settings.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export type LinkPurpose = 'invite' | 'reset' | 'verify';

/** How long each kind of link stays usable. */
export const LINK_TTL_MS: Record<LinkPurpose, number> = {
  invite: 72 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  verify: 24 * 60 * 60 * 1000,
};

export const hashLinkToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Wrong guesses a verify code survives; the next one spends it. */
export const MAX_CODE_ATTEMPTS = 5;

/** The code is hashed with its account, so equal codes for two people never share a hash. */
export const hashCode = (userId: string, code: string) => hashLinkToken(`${userId}:${code}`);

/** The portal path a link opens. All three land on the same set-password page. */
export function linkUrl(portalUrl: string, purpose: LinkPurpose, token: string): string {
  return `${portalUrl}/set-password?purpose=${purpose}&token=${encodeURIComponent(token)}`;
}

/**
 * Invitation and password-reset links (ADR-072).
 *
 * A link is a random token, stored only as its hash, used once, and expiring.
 * Mail is the delivery, not the mechanism: with no SMTP configured (in the
 * portal or by `SMTP_URL`) the link is still issued and returned to the admin
 * who asked, so a mail outage never locks anyone out of the platform.
 */
@Injectable()
export class UserLinksService {
  private readonly logger = new Logger(UserLinksService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly mail: MailSettingsService,
  ) {}

  async mailEnabled(): Promise<boolean> {
    return (await this.mail.get()).mailEnabled;
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
    // ponytail: 6 digits are guessable alone; MAX_CODE_ATTEMPTS and the
    // two-minute resend limit are what make them safe.
    const code = purpose === 'verify' ? String(randomInt(0, 1_000_000)).padStart(6, '0') : undefined;

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
        codeHash: code ? hashCode(user.id, code) : null,
        expiresAt: new Date(Date.now() + LINK_TTL_MS[purpose]),
      });
    });

    const portal = await this.portalUrl();
    const url = linkUrl(portal, purpose, token);
    return { url, mailed: await this.send(user, purpose, portal, url, code) };
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
      metadata: { email, matched: Boolean(user?.isActive) },
    });

    if (!user?.isActive || !(await this.mailEnabled())) return;
    await this.issueUnlessRecent(user, 'reset');
  }

  /** Re-sends a verify mail to an unverified address; silent for any other. */
  async resendVerification(email: string): Promise<void> {
    const [user] = await this.database.db
      .select({ id: users.id, email: users.email, name: users.name, verified: users.emailVerifiedAt })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    if (!user || user.verified || !(await this.mailEnabled())) return;
    await this.issueUnlessRecent(user, 'verify');
  }

  /**
   * Issues a link unless one of the same purpose went out in the last two
   * minutes, for the public forms that anyone can submit repeatedly.
   */
  async issueUnlessRecent(
    user: { id: string; email: string; name: string },
    purpose: LinkPurpose,
  ): Promise<void> {
    // ponytail: one recent link per account stands in for a rate limiter; add
    // a per-IP throttle if the forms are ever abused across many addresses.
    const [recent] = await this.database.db
      .select({ id: userTokens.id })
      .from(userTokens)
      .where(
        and(
          eq(userTokens.userId, user.id),
          eq(userTokens.purpose, purpose),
          gt(userTokens.createdAt, new Date(Date.now() - 2 * 60 * 1000)),
        ),
      )
      .limit(1);
    if (!recent) await this.issue(user, purpose);
  }

  /**
   * Sets a password from a link. The token is consumed in the same statement
   * that checks it, so two submissions of one link cannot both succeed. Every
   * session of the account is revoked: whoever held the old password is out.
   * Any link also proves the inbox, so the address counts as verified.
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
    await this.finish(consumed, newPassword, ipAddress);
  }

  /**
   * Sets a password from the 6-digit code in a verify mail, typed on the
   * sign-up page. A wrong code costs one of MAX_CODE_ATTEMPTS; the last one
   * spends the token, so guessing ends with asking for a new mail. Refusals
   * read the same whatever the reason, so the form reveals no addresses.
   */
  async redeemCode(email: string, code: string, newPassword: string, ipAddress: string | null): Promise<void> {
    const refused = new BadRequestException('That code is wrong or has expired. Check the email, or send a new code.');
    const [user] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    if (!user) throw refused;

    const live = and(
      eq(userTokens.userId, user.id),
      eq(userTokens.purpose, 'verify'),
      isNull(userTokens.usedAt),
      gt(userTokens.expiresAt, new Date()),
    );
    const [consumed] = await this.database.db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(and(live, eq(userTokens.codeHash, hashCode(user.id, code))))
      .returning({ userId: userTokens.userId, purpose: userTokens.purpose });

    if (!consumed) {
      // One statement, so concurrent wrong guesses cannot each read a low count.
      await this.database.db
        .update(userTokens)
        .set({
          attempts: sql`${userTokens.attempts} + 1`,
          usedAt: sql`case when ${userTokens.attempts} + 1 >= ${MAX_CODE_ATTEMPTS} then now() end`,
        })
        .where(live);
      throw refused;
    }
    await this.finish(consumed, newPassword, ipAddress);
  }

  private async finish(
    consumed: { userId: string; purpose: string },
    newPassword: string,
    ipAddress: string | null,
  ): Promise<void> {
    await this.database.db
      .update(users)
      .set({
        passwordHash: await this.passwords.hash(newPassword),
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, consumed.userId));
    await this.tokens.revokeAllForUser(consumed.userId);

    await this.audit.record({
      event: AUDIT_EVENTS.USER_LINK_REDEEMED,
      userId: consumed.userId,
      ipAddress,
      metadata: { purpose: consumed.purpose },
    });
  }

  private async portalUrl(): Promise<string> {
    const url = await this.mail.portalUrl();
    if (!url) {
      throw new BadRequestException(
        'The portal URL is not set (Settings → Email, or PORTAL_PUBLIC_URL), so a link back to the portal cannot be built.',
      );
    }
    return url;
  }

  /** False when mail is off or the send failed; the link itself is still valid. */
  private async send(
    user: { email: string; name: string },
    purpose: LinkPurpose,
    portal: string,
    url: string,
    code: string | undefined,
  ): Promise<boolean> {
    const transport = await this.mail.transport().catch((error: Error) => {
      this.logger.error(`Mail settings could not be read: ${error.message}`);
      return null;
    });
    if (!transport) return false;

    const { subject, intro, button, outro } = MAIL[purpose];
    const body = renderMail(portal, { name: user.name, intro, button: { label: button, url }, code, outro });

    try {
      await transport.mailer.sendMail({ from: transport.from, to: user.email, subject, ...body });
      return true;
    } catch (error) {
      // The address is not logged: it is personal data, and the audit row has it.
      this.logger.error(`Mail for a ${purpose} link failed: ${(error as Error).message}`);
      return false;
    }
  }
}

const MAIL: Record<LinkPurpose, { subject: string; intro: string; button: string; outro: string }> = {
  invite: {
    subject: 'You are invited to Cartenz',
    intro: 'An account was created for you on Cartenz. Choose a password to start.',
    button: 'Choose your password',
    outro: 'The link works once and expires in 72 hours.',
  },
  reset: {
    subject: 'Reset your Cartenz password',
    intro: 'Somebody asked to reset the password for this account. If it was you, choose a new one.',
    button: 'Reset password',
    outro: 'The link works once and expires in 1 hour. If you did not ask, ignore this email; your password stays as it is.',
  },
  verify: {
    subject: 'Your Cartenz sign-up code',
    intro: 'Somebody signed up to Cartenz with this address. If it was you, confirm it and choose your password.',
    button: 'Confirm and choose password',
    outro: 'The link and the code work once, together, and expire in 24 hours. If it was not you, ignore this email; no account becomes usable without it.',
  },
};
