import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOdooOnlineConnectionDto } from './dto/project.dto';

/**
 * The request shape for editing an existing Odoo Online connection's url,
 * login, db and/or API key (project settings, "Odoo instance").
 *
 * A development/staging Odoo Online instance's address genuinely changes
 * over the project's life, and until this existed the only way to follow it
 * was delete-and-recreate the connection - which also discards its id and
 * its audit history. Every field here is optional on its own (the service
 * fills in the current value for whatever is omitted and re-verifies the
 * resulting whole); what these checks cover is that a field which IS sent
 * cannot be sent blank, which is a value no live instance would ever have.
 */
const hasError = (errors: { property: string }[], property: string) =>
  errors.some((error) => error.property === property);

describe('UpdateOdooOnlineConnectionDto', () => {
  it('accepts an empty body at the DTO level (the service enforces "at least one")', async () => {
    // class-validator has no cross-field rule here by design: "at least one
    // field" is a fact about what the service does with the DTO, not about
    // any single field's own shape, so it belongs in the service - which
    // throws BadRequestException for this case - not duplicated here as a
    // validator that would have to agree with that message forever.
    expect(await validate(plainToInstance(UpdateOdooOnlineConnectionDto, {}))).toHaveLength(0);
  });

  it('accepts changing only the url', async () => {
    const errors = await validate(
      plainToInstance(UpdateOdooOnlineConnectionDto, { url: 'https://acme-staging-2.odoo.com' }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts changing only the api key', async () => {
    const errors = await validate(
      plainToInstance(UpdateOdooOnlineConnectionDto, { apiKey: 'a'.repeat(40) }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts all four fields together', async () => {
    const errors = await validate(
      plainToInstance(UpdateOdooOnlineConnectionDto, {
        url: 'https://acme-staging-2.odoo.com',
        login: 'dev@acme.test',
        db: 'acme-staging-2',
        apiKey: 'a'.repeat(40),
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('refuses a url sent as an empty string rather than omitted', async () => {
    const errors = await validate(plainToInstance(UpdateOdooOnlineConnectionDto, { url: '' }));
    expect(hasError(errors, 'url')).toBe(true);
  });

  it('refuses a login sent as an empty string', async () => {
    const errors = await validate(plainToInstance(UpdateOdooOnlineConnectionDto, { login: '' }));
    expect(hasError(errors, 'login')).toBe(true);
  });

  it('refuses an api key sent as an empty string', async () => {
    const errors = await validate(plainToInstance(UpdateOdooOnlineConnectionDto, { apiKey: '' }));
    expect(hasError(errors, 'apiKey')).toBe(true);
  });

  it('trims whitespace around the url and login', async () => {
    const instance = plainToInstance(UpdateOdooOnlineConnectionDto, {
      url: '  https://acme.odoo.com  ',
      login: '  dev@acme.test  ',
    });
    expect(instance.url).toBe('https://acme.odoo.com');
    expect(instance.login).toBe('dev@acme.test');
  });

  it('refuses a login over the email column length', async () => {
    const errors = await validate(
      plainToInstance(UpdateOdooOnlineConnectionDto, { login: `${'a'.repeat(321)}@acme.test` }),
    );
    expect(hasError(errors, 'login')).toBe(true);
  });
});

/**
 * The service method itself needs a live Odoo Online endpoint to call
 * (`verifyOdooOnlineCredentials`), which is why it has no database-level unit
 * test here - the same reason `createConnection`'s odoo_api path has none.
 * What is asserted against the source instead, the same way
 * `empty-and-denied-outcome.spec.ts` does for a comparable case, is that the
 * properties a reviewer most needs to trust are actually in the code: the
 * full resulting set is re-verified (not just the changed field), the key is
 * unsealed to re-authenticate an omitted one, and admin access is required
 * exactly like every other connection mutation.
 */
describe('ProjectsService.updateOdooOnlineConnection — source properties', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const source: string = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'projects.service.ts'),
    'utf8',
  );
  const block = source.slice(source.indexOf('async updateOdooOnlineConnection'));

  it('requires admin access, like every other connection mutation', () => {
    expect(block.slice(0, 400)).toMatch(/requireAdmin:\s*true/);
  });

  it('refuses an empty body rather than silently doing nothing', () => {
    expect(block).toMatch(/Supply at least one of url, login, db or apiKey/);
  });

  it('refuses a connection that is not odoo_api', () => {
    expect(block).toMatch(/connection\.connectionType !== 'odoo_api'/);
  });

  it('unseals the existing key to re-authenticate when apiKey is omitted', () => {
    expect(block).toMatch(/this\.secrets\.read\(connection\.secretRef\)/);
  });

  it('re-verifies the FULL resulting set, not just the changed field', () => {
    expect(block).toMatch(/this\.verifyOdooOnlineCredentials\(\{/);
  });

  it('only re-seals the key when apiKey was actually supplied', () => {
    const sealBlock = block.slice(block.indexOf('let secretRef'));
    expect(sealBlock).toMatch(/if \(dto\.apiKey\) \{/);
  });

  it('destroys the old secret record once a new one is sealed', () => {
    const sealBlock = block.slice(block.indexOf('let secretRef'));
    expect(sealBlock).toMatch(/this\.secrets\.destroy\(connection\.secretRef\)/);
  });

  it('records an audit event naming which fields changed', () => {
    expect(block).toMatch(/AUDIT_EVENTS\.PROJECT_CONNECTION_UPDATED/);
    expect(block).toMatch(/changed:/);
  });
});
