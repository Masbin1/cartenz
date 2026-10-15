import { BadRequestException } from '@nestjs/common';
import { MAX_CODE_ATTEMPTS, UserLinksService, hashCode, hashLinkToken, linkUrl } from './user-links.service';
import { PasswordService } from './password.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { TokenService } from './token.service';
import type { MailSettingsService } from '../settings/mail-settings.service';

/**
 * ADR-072. What matters is the refusals: a link works once, a spent or unknown
 * link changes nothing, and redeeming one signs the account out everywhere.
 */
describe('user links', () => {
  const passwords = new PasswordService();
  const noAudit = { record: async () => undefined } as unknown as AuditService;
  const mail = {
    get: async () => ({ mailEnabled: false }),
    transport: async () => null,
    portalUrl: async () => 'https://cartenz.test',
  } as unknown as MailSettingsService;

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

    const service = new UserLinksService(db, passwords, tokens, noAudit, mail);
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

  /**
   * The verify code. The fake keeps one token row and applies the same two
   * updates the service sends: consume on a matching code, or count a miss and
   * spend the token on the last allowed one.
   */
  describe('verify code', () => {
    function buildCode() {
      const row = { codeHash: hashCode('user-1', '123456'), attempts: 0, used: false };
      const user = { passwordHash: 'old' };
      let lastSet: Record<string, unknown> = {};
      let guessed = '';
      const db = {
        db: {
          select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'user-1' }] }) }) }),
          update: () => ({
            set: (values: Record<string, unknown>) => {
              lastSet = values;
              return {
                where: () => {
                  if ('passwordHash' in values) {
                    user.passwordHash = values.passwordHash as string;
                    return Promise.resolve();
                  }
                  if ('attempts' in lastSet) {
                    if (!row.used) {
                      row.attempts += 1;
                      if (row.attempts >= MAX_CODE_ATTEMPTS) row.used = true;
                    }
                    return Promise.resolve();
                  }
                  return {
                    returning: async () => {
                      if (row.used || hashCode('user-1', guessed) !== row.codeHash) return [];
                      row.used = true;
                      return [{ userId: 'user-1', purpose: 'verify' }];
                    },
                  };
                },
              };
            },
          }),
        },
      } as unknown as DatabaseService;
      const tokens = { revokeAllForUser: async () => undefined } as unknown as TokenService;
      const service = new UserLinksService(db, passwords, tokens, noAudit, mail);
      const redeem = (code: string) => {
        guessed = code;
        return service.redeemCode('b@linkederp.com', code, 'new-password-456', null);
      };
      return { redeem, row, user };
    }

    it('sets the password with the right code, once', async () => {
      const { redeem, user } = buildCode();
      await redeem('123456');
      expect(await passwords.verify('new-password-456', user.passwordHash)).toBe(true);
      await expect(redeem('123456')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('spends the code after five wrong guesses, even for the right one after', async () => {
      const { redeem, row, user } = buildCode();
      for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
        await expect(redeem('000000')).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(row.used).toBe(true);
      await expect(redeem('123456')).rejects.toBeInstanceOf(BadRequestException);
      expect(user.passwordHash).toBe('old');
    });
  });
});
