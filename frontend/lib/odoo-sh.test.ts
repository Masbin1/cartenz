import test from 'node:test';
import assert from 'node:assert/strict';
import { ODOO_SH_OWNER, ODOO_SH_REPOSITORY, odooShRegionLabel, odooShSignupOf } from './odoo-sh';

test('region labels follow the Odoo.sh map, including its sa/me spelling', () => {
  assert.equal(odooShRegionLabel('as'), 'Southeast Asia');
  assert.equal(odooShRegionLabel('sa'), 'Middle East');
  assert.equal(odooShRegionLabel('me'), 'Southern Asia');
});

test('owner and repository rules match the backend DTO', () => {
  assert.ok(ODOO_SH_OWNER.test('BintangLinked'));
  assert.ok(!ODOO_SH_OWNER.test('Bintang/Linked'));
  assert.ok(ODOO_SH_REPOSITORY.test('equipment-management'));
  assert.ok(!ODOO_SH_REPOSITORY.test('equipment management'));
});

test('reads the stored plan only from an assisted odoo_sh project', () => {
  const signup = { owner: 'BintangLinked', repositoryName: 'equip', region: 'as', odooVersion: '19.0' };
  assert.deepEqual(
    odooShSignupOf({ projectType: 'odoo_sh', environmentConfig: { hosting: 'odoo_sh', signup } }),
    signup,
  );
  assert.equal(odooShSignupOf({ projectType: 'odoo_sh', environmentConfig: {} }), null);
  assert.equal(
    odooShSignupOf({ projectType: 'odoo_online', environmentConfig: { hosting: 'odoo_sh', signup } }),
    null,
  );
});
