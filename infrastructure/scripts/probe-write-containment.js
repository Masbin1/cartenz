/**
 * Asks the compiled write tools to modify a path outside the task's workspace,
 * and reports what happened.
 *
 * The paths probed are the ones a consultancy host actually has: the shared Odoo
 * core, the enterprise addons, another client's custom addons, and the developer's
 * own working copy. A project scoped to one module directory must not be able to
 * reach any of them, and that has to be demonstrable rather than asserted.
 *
 * Exits 0 only if every attempt was refused.
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DIST = path.resolve(__dirname, '../../backend/dist');
const { resolveWritablePath, resolveExistingPath } = require(
  path.join(DIST, 'agent/workspace/workspace-path.js'),
);

// A stand-in for a task workspace: the only directory a task may write to.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'containment-probe-'));
fs.mkdirSync(path.join(workspace, 'vif_sales_incentive', 'models'), { recursive: true });

const HOME = process.env.HOME ?? '/home/masbintang';

const OUTSIDE = [
  ['the shared Odoo core', `${HOME}/linkederp/base/odoo/addons/sale/models/sale_order.py`],
  ['the enterprise addons', `${HOME}/linkederp/base/enterprise/sale_subscription/__manifest__.py`],
  ["another client's addons", `${HOME}/linkederp/omnisurge/Odoo/omnisurge_sale/models/sale_order.py`],
  ["the developer's working copy", `${HOME}/linkederp/vania/module/vania/vif_sales_incentive/x.py`],
  ['an odoo.conf holding credentials', `${HOME}/linkederp/vania/odoo.conf`],
  ['traversal out of the workspace', '../../../base/enterprise/evil.py'],
  ['traversal disguised mid-path', 'vif_sales_incentive/../../../../base/enterprise/evil.py'],
  ['an absolute path to /etc', '/etc/passwd'],
  ['the workspace root itself, escaped', `${workspace}/../escaped.py`],
];

let failures = 0;

async function refused(label, target) {
  for (const [name, resolve] of [
    ['resolveWritablePath', resolveWritablePath],
    ['resolveExistingPath', resolveExistingPath],
  ]) {
    try {
      await resolve(workspace, target);
      console.log(`  FAIL  ${name} permitted ${label}`);
      failures += 1;
    } catch {
      // Refused, which is the whole point. Which error does not matter.
    }
  }
  console.log(`  PASS  ${label} refused`);
}

async function main() {
  console.log(`workspace: ${workspace}`);
  console.log('Every path below is outside it.');
  console.log();

  for (const [label, target] of OUTSIDE) {
    await refused(label, target);
  }

  // The control. Without it this probe would pass just as well against a
  // resolver that refuses everything, which would be useless rather than safe.
  console.log();
  try {
    const inside = await resolveWritablePath(workspace, 'vif_sales_incentive/models/sale_order.py');
    if (inside.startsWith(workspace)) {
      console.log('  PASS  a path inside the module is still permitted');
    } else {
      console.log(`  FAIL  an inside path resolved outside the workspace: ${inside}`);
      failures += 1;
    }
  } catch (error) {
    console.log(`  FAIL  an inside path was refused: ${error.message}`);
    failures += 1;
  }

  fs.rmSync(workspace, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\nCONTAINMENT PROBE FAILED (${failures} case(s) not refused)`);
    process.exit(1);
  }
  console.log(`\nCONTAINMENT PROBE PASSED (${OUTSIDE.length + 1} checks against backend/dist)`);
}

main().catch((error) => {
  console.error(`probe error: ${error.stack}`);
  process.exit(1);
});
