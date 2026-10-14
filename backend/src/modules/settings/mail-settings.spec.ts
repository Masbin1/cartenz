import { BadRequestException } from '@nestjs/common';
import { MailSettingsService, normalisePortalUrl } from './mail-settings.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { SecretsProvider } from '../../core/secrets/secrets.provider';
import type { AppConfig } from '../../core/config/configuration';

/** ADR-072 addendum: the portal row wins when it names a host; env otherwise. */
describe('mail settings', () => {
  const build = (row: Record<string, unknown> | null, smtpUrl: string | null) => {
    const db = {
      db: { select: () => ({ from: () => ({ limit: async () => (row ? [row] : []) }) }) },
    } as unknown as DatabaseService;
    const config = {
      mail: { smtpUrl, from: 'Env <env@x.test>' },
      push: { portalUrl: 'https://env.test' },
    } as unknown as AppConfig;
    const secrets = { read: async () => 'sealed-password' } as unknown as SecretsProvider;
    return new MailSettingsService(db, {} as AuditService, secrets, config);
  };

  it('is off with neither a portal host nor SMTP_URL', async () => {
    const service = build(null, null);
    expect(await service.transport()).toBeNull();
    expect((await service.get()).mailEnabled).toBe(false);
  });

  it('falls back to the environment when the portal names no host', async () => {
    const service = build({ smtpHost: null, portalUrl: null }, 'smtp://env.test:587');
    expect((await service.transport())?.from).toBe('Env <env@x.test>');
    expect(await service.portalUrl()).toBe('https://env.test');
    expect((await service.get()).smtpFromEnvironment).toBe(true);
  });

  it('prefers the portal settings and never returns the password', async () => {
    const service = build(
      {
        smtpHost: 'smtp.portal.test',
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: 'u',
        smtpPasswordRef: 'ref-1',
        mailFrom: 'Portal <p@x.test>',
        portalUrl: 'https://portal.test',
      },
      'smtp://env.test:587',
    );
    expect((await service.transport())?.from).toBe('Portal <p@x.test>');
    expect(await service.portalUrl()).toBe('https://portal.test');

    const shown = await service.get();
    expect(shown.hasPassword).toBe(true);
    expect(JSON.stringify(shown)).not.toContain('sealed-password');
    expect(JSON.stringify(shown)).not.toContain('ref-1');
  });

  it('normalises the portal URL and refuses anything that is not http(s)', () => {
    expect(normalisePortalUrl(' https://cartenz.test/// ')).toBe('https://cartenz.test');
    expect(normalisePortalUrl('')).toBeNull();
    expect(() => normalisePortalUrl('cartenz.test')).toThrow(BadRequestException);
    expect(() => normalisePortalUrl('javascript:alert(1)')).toThrow(BadRequestException);
  });
});
