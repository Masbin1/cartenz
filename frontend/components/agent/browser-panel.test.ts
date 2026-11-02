import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from './browser-panel';

test('normalizeUrl adds https to a bare host and refuses non-web schemes', () => {
  assert.equal(normalizeUrl('acme.odoo.com/web'), 'https://acme.odoo.com/web');
  assert.equal(normalizeUrl(' http://localhost:8069 '), 'http://localhost:8069/');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('data:text/html,hi'), null);
  assert.equal(normalizeUrl('   '), null);
});
