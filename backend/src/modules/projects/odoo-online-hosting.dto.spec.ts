import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAiProjectDto } from './dto/project.dto';

/**
 * The Odoo Online hosting additions to the Create-with-AI payload. These are
 * pure boundary checks with no database behind them: what the form may send,
 * and what it must not.
 */
const base = {
  region: 'indonesia',
  name: 'Equipment Management',
  odooVersion: '19.0',
  description: 'Manage company assets.',
  requirements: [{ title: 'Register equipment against an employee' }],
};

const build = (overrides: Record<string, unknown>) =>
  plainToInstance(CreateAiProjectDto, { ...base, ...overrides });

const hasError = (errors: { property: string }[], property: string) =>
  errors.some((error) => error.property === property);

describe('CreateAiProjectDto hosting', () => {
  it('accepts the default on-host shape unchanged', async () => {
    expect(await validate(build({}))).toHaveLength(0);
    expect(await validate(build({ hosting: 'on_host' }))).toHaveLength(0);
  });

  it('accepts an odoo_online project with a complete signup', async () => {
    const errors = await validate(
      build({
        hosting: 'odoo_online',
        odooOnline: {
          companyName: 'Acme Manufacturing',
          adminEmail: 'you@acme.test',
          subdomain: 'acme-manufacturing',
          fullName: 'Ayu Lestari',
          phone: '+62 812-3456-7890',
          lang: 'id_ID',
          companySize: '5-20',
          plan: 'plan_to_use',
          countryCode: 'ID',
          apps: ['account', 'sale_management'],
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('refuses a hosting target that is not offered', async () => {
    expect(hasError(await validate(build({ hosting: 'odoo_cloud' })), 'hosting')).toBe(true);
  });

  it('refuses a subdomain with an uppercase letter or a leading hyphen', async () => {
    const errors = await validate(
      build({
        hosting: 'odoo_online',
        odooOnline: {
          companyName: 'Acme',
          adminEmail: 'you@acme.test',
          subdomain: '-Acme',
          countryCode: 'ID',
          apps: [],
        },
      }),
    );
    expect(hasError(errors, 'odooOnline')).toBe(true);
  });

  it('refuses an app name that is not a module technical name', async () => {
    const errors = await validate(
      build({
        hosting: 'odoo_online',
        odooOnline: {
          companyName: 'Acme',
          adminEmail: 'you@acme.test',
          subdomain: 'acme',
          countryCode: 'ID',
          apps: ['account', 'Bad-App'],
        },
      }),
    );
    expect(hasError(errors, 'odooOnline')).toBe(true);
  });

  it('refuses a company size odoo.com does not offer', async () => {
    const errors = await validate(
      build({
        hosting: 'odoo_online',
        odooOnline: {
          companyName: 'Acme',
          adminEmail: 'you@acme.test',
          subdomain: 'acme',
          countryCode: 'ID',
          companySize: '1000',
          apps: [],
        },
      }),
    );
    expect(hasError(errors, 'odooOnline')).toBe(true);
  });

  it('refuses an admin email that is not an email', async () => {
    const errors = await validate(
      build({
        hosting: 'odoo_online',
        odooOnline: {
          companyName: 'Acme',
          adminEmail: 'not-an-email',
          subdomain: 'acme',
          countryCode: 'ID',
          apps: [],
        },
      }),
    );
    expect(hasError(errors, 'odooOnline')).toBe(true);
  });
});
