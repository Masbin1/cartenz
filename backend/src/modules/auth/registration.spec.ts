import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { OrganizationService, emailDomain, normaliseDomains } from '../settings/organization.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { TokenService } from './token.service';
import type { UserLinksService } from './user-links.service';
import type { AppConfig } from '../../core/config/configuration';

/**
 * ADR-072 addendum 2. What matters is the refusals: a foreign domain is turned
 * away, sign-up never says whether an address is taken, and an unverified
 * account cannot sign in even with the right password.
 */
describe('domain-restricted registration', () => {
  const passwords = new PasswordService();
  const noAudit = { record: async () => undefined } as unknown as AuditService;
  const config = { auth: { accessTtl: '15m' } } as unknown as AppConfig;
  const org = (domains: string[]) =>
    new OrganizationService(
      { db: { select: () => ({ from: () => ({ limit: async () => [{ name: 'LinkedERP', allowedDomains: domains }] }) }) } } as unknown as DatabaseService,
      noAudit,
    );

  /** `rows` answers every select: [] for an unknown address, one row for a taken one. */
  function build(rows: Record<string, unknown>[], mailEnabled = true) {
    const issued: string[] = [];
    const inserted: unknown[] = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => rows,
      then: (resolve: (value: unknown) => void) => resolve([{ total: 1 }]),
    };
    const db = {
      db: {
        select: () => chain,
        insert: () => ({
          values: (values: unknown) => {
            inserted.push(values);
            return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'new', email: 'x', name: 'x', region: 'indonesia' }] }) };
          },
        }),
      },
    } as unknown as DatabaseService;
    const links = {
      mailEnabled: async () => mailEnabled,
      issue: async (_: unknown, purpose: string) => void issued.push(purpose),
      issueUnlessRecent: async (_: unknown, purpose: string) => void issued.push(`again:${purpose}`),
    } as unknown as UserLinksService;
    const service = new AuthService(db, passwords, {} as TokenService, noAudit, config, links, org(['linkederp.com']));
    return { service, issued, inserted };
  }
  const dto = (email: string) => ({ email, name: 'Bintang', region: 'indonesia' as const });

  it('normalises domains and refuses anything that is not one', () => {
    expect(normaliseDomains([' @LinkedERP.com', 'linkederp.com', ''])).toEqual(['linkederp.com']);
    expect(() => normaliseDomains(['not a domain'])).toThrow(BadRequestException);
    expect(emailDomain('a@b@Sub.Example.com')).toBe('sub.example.com');
  });

  it('refuses an address outside the allowed domains', async () => {
    const { service, issued } = build([]);
    await expect(service.registerByEmail(dto('bintang@gmail.com'), null)).rejects.toBeInstanceOf(ForbiddenException);
    expect(issued).toEqual([]);
  });

  it('refuses sign-up when no mail can confirm the address', async () => {
    const { service } = build([], false);
    await expect(service.registerByEmail(dto('bintang@linkederp.com'), null)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates an unverified account and mails a verify link', async () => {
    const { service, issued, inserted } = build([]);
    expect(await service.registerByEmail(dto('bintangkkk@linkederp.com'), null)).toEqual({ pending: true });
    expect(issued).toEqual(['verify']);
    expect(inserted[0]).not.toHaveProperty('emailVerifiedAt');
  });

  it('answers a taken address the same way and creates nothing', async () => {
    const verified = build([{ id: 'u', email: 'b@linkederp.com', name: 'B', verified: new Date() }]);
    expect(await verified.service.registerByEmail(dto('b@linkederp.com'), null)).toEqual({ pending: true });
    expect(verified.issued).toEqual([]);
    expect(verified.inserted).toEqual([]);

    const pending = build([{ id: 'u', email: 'b@linkederp.com', name: 'B', verified: null }]);
    await pending.service.registerByEmail(dto('b@linkederp.com'), null);
    expect(pending.issued).toEqual(['again:verify']);
  });

  it('refuses sign-in to an unverified account even with the right password', async () => {
    const hash = await passwords.hash('right-password-123');
    const { service } = build([
      { id: 'u', email: 'b@linkederp.com', name: 'B', region: 'indonesia', isAdmin: false, isActive: true, passwordHash: hash, emailVerifiedAt: null },
    ]);
    await expect(service.login({ email: 'b@linkederp.com', password: 'right-password-123' }, null)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  describe('sign-in code', () => {
    async function loginWith(opts: { trusted: boolean; mailEnabled: boolean; mailed?: boolean }) {
      const hash = await passwords.hash('right-password-123');
      const account = {
        id: 'u', email: 'b@linkederp.com', name: 'B', region: 'indonesia', isAdmin: false,
        isActive: true, passwordHash: hash, emailVerifiedAt: new Date(),
      };
      const chain = { from: () => chain, where: () => chain, limit: async () => [account] };
      const db = {
        db: {
          select: () => chain,
          update: () => ({ set: () => ({ where: () => ({ returning: async () => [account] }) }) }),
        },
      } as unknown as DatabaseService;
      const audited: string[] = [];
      const audit = { record: async (e: { event: string }) => void audited.push(e.event) } as unknown as AuditService;
      const links = {
        isTrusted: async () => opts.trusted,
        mailEnabled: async () => opts.mailEnabled,
        startLogin: async () => ({ challenge: 'c', mailed: opts.mailed ?? true }),
      } as unknown as UserLinksService;
      const tokens = { issuePair: async () => ({ accessToken: 'a', refreshToken: 'r' }) } as unknown as TokenService;
      const service = new AuthService(db, passwords, tokens, audit, config, links, org(['linkederp.com']));
      const answer = await service.login({ email: 'b@linkederp.com', password: 'right-password-123', deviceToken: 'd' }, null);
      return { answer, audited };
    }

    it('asks a browser it has not seen for a code, and opens no session', async () => {
      const { answer } = await loginWith({ trusted: false, mailEnabled: true });
      expect(answer).toEqual({ otpRequired: true, challenge: 'c' });
    });

    it('lets a trusted browser straight in', async () => {
      const { answer } = await loginWith({ trusted: true, mailEnabled: true });
      expect(answer).toHaveProperty('accessToken', 'a');
    });

    it('skips the code when mail is off or the send failed, and audits it', async () => {
      for (const opts of [{ mailEnabled: false }, { mailEnabled: true, mailed: false }]) {
        const { answer, audited } = await loginWith({ trusted: false, ...opts });
        expect(answer).toHaveProperty('accessToken', 'a');
        expect(audited).toContain('user.login_otp_skipped');
      }
    });
  });
});
