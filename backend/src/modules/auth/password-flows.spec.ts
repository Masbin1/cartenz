import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { TokenService } from './token.service';
import type { AppConfig } from '../../core/config/configuration';

/**
 * The two password flows the portal offers (ADR-044 extended):
 *
 * - changePassword: the caller proves the current password, gets a new one, and
 *   every other session is revoked.
 * - resetPassword: an admin sets a password for someone else without knowing
 *   the old one. Manual stand-in for an email flow, so there is no email here
 *   by design.
 *
 * The assertions that matter are the refusals: a wrong current password must
 * not change anything, and a reset must revoke the target's sessions.
 */
describe('password flows', () => {
  const passwords = new PasswordService();

  const noAudit = { record: async () => undefined } as unknown as AuditService;
  const config = {
    auth: { accessTtl: '15m', refreshTtl: '30d', jwtSecret: 'test-secret' },
  } as unknown as AppConfig;

  /** An in-memory stand-in for the one row the service reads and writes. */
  function build(hash: string) {
    const row = { id: 'user-1', email: 'a@b.test', passwordHash: hash, isActive: true };

    const db = {
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }) }),
        update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => {
          row.passwordHash = (values as { passwordHash: string }).passwordHash;
          return Promise.resolve();
        } }) }),
      },
    } as unknown as DatabaseService;

    const revocations: string[] = [];
    const tokens = {
      revokeAllForUser: async (userId: string) => {
        revocations.push(userId);
      },
    } as unknown as TokenService;

    const service = new AuthService(db, passwords, tokens, noAudit, config);

    return { service, row, revocations };
  }

  describe('changePassword', () => {
    it('changes the password when the current one is right', async () => {
      const { service, row } = build(await passwords.hash('old-password-123'));
      const result = await service.changePassword(
        'user-1',
        { currentPassword: 'old-password-123', newPassword: 'new-password-456' },
        null,
      );

      expect(result).toEqual({ changed: true });
      await expect(passwords.verify('new-password-456', row.passwordHash)).resolves.toBe(true);
      await expect(passwords.verify('old-password-123', row.passwordHash)).resolves.toBe(false);
    });

    it('refuses a wrong current password and changes nothing', async () => {
      const { service, row } = build(await passwords.hash('old-password-123'));
      const before = row.passwordHash;

      await expect(
        service.changePassword(
          'user-1',
          { currentPassword: 'wrong-password-99', newPassword: 'new-password-456' },
          null,
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(row.passwordHash).toBe(before);
    });

    it('refuses a new password identical to the current one', async () => {
      const { service, row } = build(await passwords.hash('same-password-123'));
      const before = row.passwordHash;

      await expect(
        service.changePassword(
          'user-1',
          { currentPassword: 'same-password-123', newPassword: 'same-password-123' },
          null,
        ),
      ).rejects.toThrow(/differ/);

      expect(row.passwordHash).toBe(before);
    });

    it('revokes every other session on success', async () => {
      const { service, revocations } = build(await passwords.hash('old-password-123'));
      await service.changePassword(
        'user-1',
        { currentPassword: 'old-password-123', newPassword: 'new-password-456' },
        null,
      );

      expect(revocations).toContain('user-1');
    });

    it('revokes nothing when the current password is wrong', async () => {
      const { service, revocations } = build(await passwords.hash('old-password-123'));
      await expect(
        service.changePassword(
          'user-1',
          { currentPassword: 'wrong-password-99', newPassword: 'new-password-456' },
          null,
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(revocations).toHaveLength(0);
    });
  });

  describe('resetPassword', () => {
    it('sets the new password without knowing the old one', async () => {
      const { service, row } = build(await passwords.hash('forgotten-password'));
      const result = await service.resetPassword(
        { userId: 'admin-1', isAdmin: true },
        'user-1',
        { newPassword: 'admin-given-password' },
        null,
      );

      expect(result).toEqual({ reset: true });
      await expect(passwords.verify('admin-given-password', row.passwordHash)).resolves.toBe(true);
      await expect(passwords.verify('forgotten-password', row.passwordHash)).resolves.toBe(false);
    });

    it('revokes the target sessions, because the old credential must not stay live', async () => {
      const { service, revocations } = build(await passwords.hash('forgotten-password'));
      await service.resetPassword(
        { userId: 'admin-1', isAdmin: true },
        'user-1',
        { newPassword: 'admin-given-password' },
        null,
      );

      expect(revocations).toContain('user-1');
    });
  });
});
