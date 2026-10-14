import { BadRequestException } from '@nestjs/common';
import { UserLinksService, hashLinkToken, linkUrl } from './user-links.service';
import { PasswordService } from './password.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { TokenService } from './token.service';
import type { AppConfig } from '../../core/config/configuration';

/**
 * ADR-072. What matters is the refusals: a link works once, a spent or unknown
 * link changes nothing, and redeeming one signs the account out everywhere.
 */
describe('user links', () => {
  const passwords = new PasswordService();
  const noAudit = { record: async () => undefined } as unknown as AuditService;
  const config = {
    mail: { smtpUrl: null, from: 'x' },
    push: { portalUrl: 'https://cartenz.test' },
  } as unknown as AppConfig;

  /** One stored token and one user, with the conditional consume the service relies on. */
  function build() {
    const token = { hash: hashLinkToken('good-token'), used: false, userId: 'user-1' };
    const user = { passwordHash: 'old' };
    const revocations: string[] = [];

    const db = {
      db: {
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: () => {
              if ('usedAt' in values) {
                // Mirrors `where token_hash = ? and used_at is null and expires_at > now()`.
                return {
                  returning: async () => {
                    if (token.used || consumedHash !== token.hash) return [];
                    token.used = true;
                    return [{ userId: token.userId, purpose: 'invite' }];
                  },
                };
              }
              user.passwordHash = values.passwordHash as string;
              return Promise.resolve();
            },
          }),
        }),
      },
    } as unknown as DatabaseService;

    let consumedHash = '';
    const tokens = {
      revokeAllForUser: async (userId: string) => void revocations.push(userId),
    } as unknown as TokenService;

    const service = new UserLinksService(db, passwords, tokens, noAudit, config);
    const redeem = (raw: string) => {
      consumedHash = hashLinkToken(raw);
      return service.redeem(raw, 'new-password-456', null);
    };
    return { redeem, user, revocations };
  }

  it('sets the password once and signs the account out everywhere', async () => {
    const { redeem, user, revocations } = build();

    await redeem('good-token');

    expect(await passwords.verify('new-password-456', user.passwordHash)).toBe(true);
    expect(revocations).toEqual(['user-1']);
  });

  it('refuses a link that was already used', async () => {
    const { redeem } = build();
    await redeem('good-token');
    await expect(redeem('good-token')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an unknown link and changes nothing', async () => {
    const { redeem, user, revocations } = build();
    await expect(redeem('guessed-token')).rejects.toBeInstanceOf(BadRequestException);
    expect(user.passwordHash).toBe('old');
    expect(revocations).toEqual([]);
  });

  it('builds a link the portal page reads', () => {
    expect(linkUrl('https://cartenz.test', 'reset', 'a+b')).toBe(
      'https://cartenz.test/set-password?purpose=reset&token=a%2Bb',
    );
  });
});
