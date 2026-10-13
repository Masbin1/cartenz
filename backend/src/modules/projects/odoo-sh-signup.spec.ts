import { odooShSignupOf } from './odoo-sh-signup';

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
