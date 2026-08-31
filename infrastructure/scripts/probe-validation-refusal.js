/**
 * Asks the compiled CommandRunner to start a Python process, and reports what
 * happened.
 *
 * The companion to probe-push-refusal.js, and for the same reason: the unit tests
 * prove the source refuses, and an operator deciding whether to install this on a
 * host with production databases is entitled to evidence about the artefact that
 * runs.
 *
 * Two postures are probed. With VALIDATION_ENABLED false nothing Python may
 * start. With it true, only an odoo-bin inside a configured runtime may.
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DIST = path.resolve(__dirname, '../../backend/dist');
const { CommandRunner, SubcommandNotEnabledError, CommandArgumentError } = require(
  path.join(DIST, 'core/process/command-runner.service.js'),
);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-probe-'));
let failures = 0;

function config(enabled, runtimes) {
  return {
    process: { timeoutMs: 10_000, maxTimeoutMs: 30_000, maxOutputBytes: 1_000_000 },
    git: { pushEnabled: false },
    validation: { enabled, runtimes },
  };
}

async function refuses(runner, label, args, expected) {
  try {
    await runner.run('python3', args, { cwd });
    console.log(`  FAIL  ${label} was NOT refused`);
    failures += 1;
  } catch (error) {
    if (error instanceof expected || error.name === expected.name) {
      console.log(`  PASS  ${label} refused (${error.name})`);
    } else {
      console.log(`  FAIL  ${label} threw ${error.name}: ${error.message.slice(0, 90)}`);
      failures += 1;
    }
  }
}

async function main() {
  console.log('With VALIDATION_ENABLED=false (the default):');
  const off = new CommandRunner(config(false, ''));
  await refuses(off, 'an Odoo run', ['/opt/odoo19/odoo-bin', '-d', 'x'], SubcommandNotEnabledError);
  await refuses(off, 'an inline program', ['-c', 'import os'], SubcommandNotEnabledError);
  await refuses(off, 'a module', ['-m', 'http.server'], SubcommandNotEnabledError);
  await refuses(off, 'a bare interpreter', [], SubcommandNotEnabledError);

  console.log();
  console.log('With VALIDATION_ENABLED=true and one configured runtime:');
  const on = new CommandRunner(config(true, '19.0=/opt/odoo19'));
  await refuses(on, 'an inline program', ['-c', 'import os'], CommandArgumentError);
  await refuses(on, 'a module', ['-m', 'http.server'], CommandArgumentError);
  await refuses(on, 'a bare interpreter', [], CommandArgumentError);
  await refuses(on, 'a script that is not odoo-bin', ['/opt/odoo19/setup.py'], CommandArgumentError);
  await refuses(on, 'an odoo-bin outside the runtime', ['/tmp/odoo-bin'], CommandArgumentError);
  await refuses(
    on,
    'a look-alike directory',
    ['/opt/odoo19-evil/odoo-bin'],
    CommandArgumentError,
  );

  // The control. It must get past the guard and fail on the missing file, which
  // proves the guard permitted it rather than the probe being vacuous.
  try {
    await on.run('python3', ['/opt/odoo19/odoo-bin', '--version'], { cwd });
    console.log('  PASS  a configured odoo-bin is permitted (and ran)');
  } catch (error) {
    if (error instanceof CommandArgumentError || error.name === 'SubcommandNotEnabledError') {
      console.log(`  FAIL  a configured odoo-bin was refused: ${error.message.slice(0, 80)}`);
      failures += 1;
    } else {
      console.log(`  PASS  a configured odoo-bin got past the guard (${error.name}: no such file)`);
    }
  }

  fs.rmSync(cwd, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\nVALIDATION PROBE FAILED (${failures} case(s) not refused)`);
    process.exit(1);
  }
  console.log('\nVALIDATION PROBE PASSED (11 checks against backend/dist)');
}

main().catch((error) => {
  console.error(`probe error: ${error.stack}`);
  process.exit(1);
});
