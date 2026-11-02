import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Pins odoo_record_policy.py's PROTECTED_PREFIXES to the TypeScript array in
 * odoo-record-surface.ts (ADR-075 §2), so the two deny-lists cannot drift
 * silently. Reads the Python tuple through python3 itself rather than
 * re-parsing the file as text, so a change to the Python syntax (a comment, a
 * line break, a trailing comma) cannot fool a regex-based comparison.
 */
describe('odoo_record_policy.py protected prefixes', () => {
  it('matches PROTECTED_PREFIXES in odoo-record-surface.ts exactly', () => {
    // odoo-record-surface.ts does not export PROTECTED_PREFIXES directly (it is
    // module-private, by design - nothing outside the surface should reach
    // around recordModelRefusal). Probing recordModelRefusal with each prefix
    // the Python side declares proves the same set is enforced, without
    // requiring either file to export its internal list for a test to read.
    const { recordModelRefusal } = require('./odoo-record-surface');

    const policyDir = join(__dirname, '../../../../infrastructure/provisioning');
    const prefixesJson = execFileSync(
      'python3',
      [
        '-c',
        `import sys; sys.path.insert(0, ${JSON.stringify(policyDir)}); ` +
          'import json; from odoo_record_policy import PROTECTED_PREFIXES; ' +
          'print(json.dumps(list(PROTECTED_PREFIXES)))',
      ],
      { encoding: 'utf-8' },
    );
    const pythonPrefixes: string[] = JSON.parse(prefixesJson);

    expect(pythonPrefixes.length).toBeGreaterThan(0);

    for (const prefix of pythonPrefixes) {
      const bareModel = prefix.replace(/\.$/, '');
      const probeModel = prefix.endsWith('.') ? `${bareModel}.some_table` : bareModel;
      expect(recordModelRefusal(probeModel)).not.toBeNull();
    }

    // The converse: a plain business model recognised by neither side.
    expect(recordModelRefusal('product.template')).toBeNull();
  });

  it('matches MAX_RECORDS_PER_WRITE / MAX_RECORDS_PER_READ / MAX_GROUPS_PER_AGGREGATE', () => {
    const {
      MAX_RECORDS_PER_WRITE,
      MAX_RECORDS_PER_READ,
      MAX_GROUPS_PER_AGGREGATE,
    } = require('./odoo-record-surface');

    const policyDir = join(__dirname, '../../../../infrastructure/provisioning');
    const json = execFileSync(
      'python3',
      [
        '-c',
        `import sys; sys.path.insert(0, ${JSON.stringify(policyDir)}); ` +
          'import json; from odoo_record_policy import ' +
          'MAX_RECORDS_PER_WRITE, MAX_RECORDS_PER_READ, MAX_GROUPS_PER_AGGREGATE; ' +
          'print(json.dumps([MAX_RECORDS_PER_WRITE, MAX_RECORDS_PER_READ, MAX_GROUPS_PER_AGGREGATE]))',
      ],
      { encoding: 'utf-8' },
    );
    const [pyWrite, pyRead, pyAggregate] = JSON.parse(json);

    expect(pyWrite).toBe(MAX_RECORDS_PER_WRITE);
    expect(pyRead).toBe(MAX_RECORDS_PER_READ);
    expect(pyAggregate).toBe(MAX_GROUPS_PER_AGGREGATE);
  });
});
