import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ODOO_ONLINE_APPS,
  ODOO_ONLINE_SUBDOMAIN,
  ODOO_TRIAL_SIGNUP_URL,
  appLabel,
  odooOnlineAppGroups,
  odooOnlineInstanceUrl,
  suggestSubdomain,
  trialFillBookmarklet,
  trialSignupUrl,
} from './odoo-online-apps';

test('suggestSubdomain slugifies a project name into a valid Odoo subdomain', () => {
  assert.equal(suggestSubdomain('Equipment Management'), 'equipment-management');
  assert.equal(suggestSubdomain('  Acme  &  Sons  '), 'acme-sons');
  assert.equal(suggestSubdomain('Café 2026'), 'caf-2026');
});

test('suggestSubdomain never starts or ends with a hyphen and stays within the limit', () => {
  const long = suggestSubdomain('---   ' + 'a'.repeat(80) + '   ---');
  assert.ok(!long.startsWith('-'));
  assert.ok(!long.endsWith('-'));
  assert.ok(long.length <= 62);
});

test('odooOnlineInstanceUrl is the https address the subdomain answers on', () => {
  assert.equal(odooOnlineInstanceUrl('acme'), 'https://acme.odoo.com');
});

test('appLabel resolves a known app and falls back to the technical name', () => {
  assert.equal(appLabel('account'), 'Invoicing');
  assert.equal(appLabel('accountant'), 'Accounting');
  assert.equal(appLabel('something_unknown'), 'something_unknown');
});

test('odooOnlineAppGroups keeps every app exactly once, in catalog order', () => {
  const groups = odooOnlineAppGroups();
  const flattened = groups.flatMap((group) => group.apps.map((app) => app.technicalName));

  assert.deepEqual(flattened, ODOO_ONLINE_APPS.map((app) => app.technicalName));
  // No duplicates across groups - each app appears in exactly one category.
  assert.equal(new Set(flattened).size, flattened.length);
});

test('the catalog carries unique technical names and non-empty labels', () => {
  const names = ODOO_ONLINE_APPS.map((app) => app.technicalName);
  assert.equal(new Set(names).size, names.length);
  for (const app of ODOO_ONLINE_APPS) {
    assert.ok(app.label.length > 0, `${app.technicalName} needs a label`);
    assert.match(app.technicalName, /^[a-z][a-z0-9_]*$/);
  }
});

test('the signup link is the odoo.com trial page', () => {
  assert.equal(ODOO_TRIAL_SIGNUP_URL, 'https://www.odoo.com/trial');
});

test('trialSignupUrl carries the chosen apps via selected_app, colon-separated', () => {
  assert.equal(trialSignupUrl([]), 'https://www.odoo.com/trial');
  assert.equal(
    trialSignupUrl(['account', 'sale_management']),
    'https://www.odoo.com/trial?selected_app=account%3Asale_management',
  );
  assert.equal(
    trialSignupUrl(['account'], ' Acme & Co '),
    'https://www.odoo.com/trial?selected_app=account&company_name=Acme+%26+Co',
  );
});

test('trialSignupUrl carries a signup plan in the fragment, never the query', () => {
  const url = trialSignupUrl(['account'], 'Acme "Co"', {
    companyName: 'Acme "Co"',
    adminEmail: 'a@acme.test',
    subdomain: 'acme-co',
    countryCode: 'ID',
    phone: '+6****34',
    companySize: '5-20',
    plan: 'plan_to_sell',
  });
  const parsed = new URL(url);
  // Only what odoo.com itself reads goes to its server.
  assert.deepEqual([...parsed.searchParams.keys()], ['selected_app', 'company_name']);
  assert.ok(parsed.hash.startsWith('#cartenz='));
  const plan = JSON.parse(decodeURIComponent(parsed.hash.slice('#cartenz='.length)));
  assert.deepEqual(plan, {
    company_name: 'Acme "Co"',
    email: 'a@acme.test',
    phone: '+6****34',
    company_size: '5-20',
    plan: 'plan_to_sell',
    country: 'ID',
    db_name: 'acme-co',
  });
});

test('trialFillBookmarklet is the same for every project and carries no plan', () => {
  const url = trialFillBookmarklet();
  assert.equal(url, trialFillBookmarklet());
  assert.ok(url.startsWith('javascript:'));
  const script = decodeURIComponent(url.slice('javascript:'.length));
  assert.ok(script.includes('cartenz='));
  assert.ok(!script.includes('@'));
  new Function(script); // parses
});

test('ODOO_ONLINE_SUBDOMAIN matches the odoo.com rule', () => {
  for (const ok of ['acme', 'acme-co', 'a1b2']) assert.ok(ODOO_ONLINE_SUBDOMAIN.test(ok), ok);
  for (const bad of ['abc', '-acme', 'acme-', 'Acme', 'ac me']) assert.ok(!ODOO_ONLINE_SUBDOMAIN.test(bad), bad);
});
