import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { trustedDevices, userTokens, users } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { MailSettingsService, renderMail } from '../settings/mail-settings.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export type LinkPurpose = 'invite' | 'reset' | 'verify';
type TokenPurpose = LinkPurpose | 'login';

/** How long each kind of link stays usable. */
export const LINK_TTL_MS: Record<TokenPurpose, number> = {
  invite: 72 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  verify: 24 * 60 * 60 * 1000,
  login: 10 * 60 * 1000,
};

/** How long a browser that passed a sign-in code skips the next one. */
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const hashLinkToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Wrong guesses a sign-in code survives; the fifth spends it. */
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
    const token = await this.store(user.id, purpose);
    const portal = await this.portalUrl();
    const url = linkUrl(portal, purpose, token);
    return { url, mailed: await this.send(user, purpose, portal, url) };
  }

  /**
   * Stores a new token, spending earlier unused ones of the same purpose so
   * only the newest works. Returns the raw token; only its hash is kept.
   */
  private async store(userId: string, purpose: TokenPurpose, code?: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.database.transaction(async (tx) => {
      await tx
        .update(userTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(userTokens.userId, userId),
            eq(userTokens.purpose, purpose),
            isNull(userTokens.usedAt),
          ),
        );
      await tx.insert(userTokens).values({
        userId,
        purpose,
        tokenHash: hashLinkToken(token),
        codeHash: code ? hashCode(userId, code) : null,
        expiresAt: new Date(Date.now() + LINK_TTL_MS[purpose]),
      });
    });
    return token;
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
   * Starts a sign-in challenge after a correct password: mails a 6-digit code
   * and returns the challenge that binds it to this sign-in, so the code alone
   * opens nothing. A newer challenge spends any earlier one.
   */
  async startLogin(user: { id: string; email: string; name: string }): Promise<{ challenge: string; mailed: boolean }> {
    // ponytail: 6 digits are guessable alone; MAX_CODE_ATTEMPTS and the
    // 10-minute expiry are what make them safe.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challenge = await this.store(user.id, 'login', code);
    return { challenge, mailed: await this.send(user, 'login', await this.mail.portalUrl(), null, code) };
  }

  /**
   * Mails a new code for a live challenge, at most once per two minutes, and
   * returns the challenge to use from now on (the old one is spent).
   */
  async resendLogin(challenge: string): Promise<{ challenge: string }> {
    const [row] = await this.database.db
      .select({ userId: userTokens.userId, createdAt: userTokens.createdAt, email: users.email, name: users.name })
      .from(userTokens)
      .innerJoin(users, eq(users.id, userTokens.userId))
      .where(
        and(
          eq(userTokens.tokenHash, hashLinkToken(challenge)),
          eq(userTokens.purpose, 'login'),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException('This sign-in has expired. Sign in again.');
    if (row.createdAt.getTime() > Date.now() - 2 * 60 * 1000) return { challenge };
    return { challenge: (await this.startLogin({ id: row.userId, email: row.email, name: row.name })).challenge };
  }

  /**
   * Checks a sign-in code and returns the account it opens. A wrong code costs
   * one of MAX_CODE_ATTEMPTS; the last spends the challenge, so guessing ends
   * with signing in again.
   */
  async completeLogin(challenge: string, code: string): Promise<string> {
    const live = and(
      eq(userTokens.tokenHash, hashLinkToken(challenge)),
      eq(userTokens.purpose, 'login'),
      isNull(userTokens.usedAt),
      gt(userTokens.expiresAt, new Date()),
    );
    const refused = new BadRequestException('That code is wrong or has expired. Check the email, or sign in again.');
    const [row] = await this.database.db.select({ userId: userTokens.userId }).from(userTokens).where(live).limit(1);
    if (!row) throw refused;

    const [consumed] = await this.database.db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(and(live, eq(userTokens.codeHash, hashCode(row.userId, code))))
      .returning({ userId: userTokens.userId });

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
    return consumed.userId;
  }

  /** Remembers this browser for the account; the raw token goes back to it. */
  async trustDevice(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.database.db.insert(trustedDevices).values({
      userId,
      tokenHash: hashLinkToken(token),
      expiresAt: new Date(Date.now() + TRUSTED_DEVICE_TTL_MS),
    });
    return token;
  }

  /** True when the browser's token was issued to this account and is still live. */
  async isTrusted(userId: string, token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const [row] = await this.database.db
      .update(trustedDevices)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(trustedDevices.tokenHash, hashLinkToken(token)),
          eq(trustedDevices.userId, userId),
          gt(trustedDevices.expiresAt, new Date()),
        ),
      )
      .returning({ id: trustedDevices.id });
    return Boolean(row);
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
    purpose: TokenPurpose,
    portal: string | null,
    url: string | null,
    code?: string,
  ): Promise<boolean> {
    const transport = await this.mail.transport().catch((error: Error) => {
      this.logger.error(`Mail settings could not be read: ${error.message}`);
      return null;
    });
    if (!transport) return false;

    const { subject, intro, button, outro } = MAIL[purpose];
    const body = renderMail(portal, {
      name: user.name,
      intro,
      ...(url && button ? { button: { label: button, url } } : {}),
      code,
      outro,
    });

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

const MAIL: Record<TokenPurpose, { subject: string; intro: string; button?: string; outro: string }> = {
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
    subject: 'Confirm your email for Cartenz',
    intro: 'Somebody signed up to Cartenz with this address. If it was you, confirm it and choose your password.',
    button: 'Confirm and choose password',
    outro: 'The link works once and expires in 24 hours. If it was not you, ignore this email; no account becomes usable without it.',
  },
  login: {
    subject: 'Your Cartenz sign-in code',
    intro: 'Somebody signed in to Cartenz with your password from a browser we have not seen. If it was you, enter this code:',
    outro: 'The code works once and expires in 10 minutes. If it was not you, change your password: somebody knows it.',
  },
};
