import { chooseOdooShToken, odooShSignupOf } from './odoo-sh-signup';

describe('odooShSignupOf', () => {
  const signup = { owner: 'BintangLinked', repositoryName: 'equip', region: 'as', odooVersion: '19.0' };

  it('reads the plan an odoo_sh creation stored', () => {
    expect(odooShSignupOf({ hosting: 'odoo_sh', signup })).toEqual(signup);
  });

  it.each([
    ['no config', null],
    ['an Odoo Online plan', { hosting: 'odoo_online', signup }],
    ['a plan without a repository', { hosting: 'odoo_sh', signup: { ...signup, repositoryName: '' } }],
  ])('is null for %s', (_label, config) => {
    expect(odooShSignupOf(config)).toBeNull();
  });
});

describe('chooseOdooShToken', () => {
  const token = { kind: 'token' as const, value: 'ghp_registered', credentialId: 'c1' };
  const key = { kind: 'ssh_key' as const, value: 'KEY', credentialId: 'c2' };

  it('uses the registered token', () => {
    expect(chooseOdooShToken({ credentialId: null, registered: token, fallback: 'ghp_env' })).toEqual({
      token: 'ghp_registered',
      credentialId: 'c1',
    });
  });

  it('falls back to GITHUB_TOKEN when nothing usable is registered and none was chosen', () => {
    for (const registered of [null, key]) {
      expect(chooseOdooShToken({ credentialId: null, registered, fallback: 'ghp_env' })).toEqual({
        token: 'ghp_env',
        credentialId: null,
      });
    }
  });

  it('never swaps an explicitly chosen credential for another token', () => {
    for (const registered of [null, key]) {
      expect(() =>
        chooseOdooShToken({ credentialId: 'c2', registered, fallback: 'ghp_env' }),
      ).toThrow(/chosen credential/);
    }
  });

  it('is null when there is no token at all', () => {
    expect(chooseOdooShToken({ credentialId: null, registered: null, fallback: null }).token).toBeNull();
  });
});
