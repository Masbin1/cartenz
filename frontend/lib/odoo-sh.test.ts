import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ODOO_SH_OWNER,
  ODOO_SH_REPOSITORY,
  odooShFillBookmarklet,
  odooShRegionLabel,
  odooShSignupOf,
} from './odoo-sh';

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

test('odooShFillBookmarklet carries the plan and runs as a javascript: URL', () => {
  const url = odooShFillBookmarklet({
    owner: 'BintangLinked',
    repositoryName: 'equip "x"',
    region: 'as',
    odooVersion: '19.0',
  });
  assert.ok(url.startsWith('javascript:'));
  const script = decodeURIComponent(url.slice('javascript:'.length));
  // The plan is embedded as JSON, so a quote in a value cannot break out of the script.
  assert.ok(script.includes(JSON.stringify('equip "x"')));
  assert.ok(script.includes('"odoo_branch"'));
  assert.ok(script.includes('location="'));
  assert.ok(script.includes('value="create"'));
  // Never anything secret: the subscription code is typed on odoo.sh.
  assert.ok(!script.includes('subscription_code"]'));
});
