/**
 * Asks the compiled CommandRunnerService to push, and reports what happened.
 *
 * This exists because the unit tests prove the source refuses, and a customer
 * deciding whether to hand over a repository is entitled to evidence about the
 * artefact that is actually running. So this loads backend/dist - the same files
 * the API and worker load - and tries the thing that must not work.
 *
 * Exits 0 only if every attempt was refused before a process was created.
 * Prints one line per attempt so a failure says which form got through.
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DIST = path.resolve(__dirname, '../../backend/dist');
const { CommandRunner, SubcommandNotEnabledError } = require(
  path.join(DIST, 'core/process/command-runner.service.js'),
);

// Every form of "push" someone might reach for, including the ones that try to
// hide the subcommand behind git's own options.
const ATTEMPTS = [
  ['push'],
  ['push', 'origin', 'HEAD'],
  ['push', '--force', 'origin', 'main'],
  ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'main'],
  ['--git-dir', '/tmp/x/.git', 'push'],
  ['PUSH'],
  ['push', '--delete', 'origin', 'production'],
];

// Deliberately the shape the real AppConfig has, with pushEnabled false - which
// is also its default. Nothing else about the platform is instantiated.
const config = {
  process: { timeoutMs: 10_000, maxTimeoutMs: 30_000, maxOutputBytes: 1_000_000 },
  git: { pushEnabled: false },
  // Also off, so this stub is the default posture of a deployment: neither
  // pushing nor starting an Odoo process (ADR-027). Probed separately by
  // probe-validation-refusal.js.
  validation: { enabled: false, runtimes: '' },
};

async function main() {
  const runner = new CommandRunner(config);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'push-probe-'));
  let failures = 0;

  for (const args of ATTEMPTS) {
    const shown = `git ${args.join(' ')}`;
    try {
      await runner.run('git', args, { cwd });
      console.log(`  FAIL  ${shown} was NOT refused`);
      failures += 1;
    } catch (error) {
      if (error instanceof SubcommandNotEnabledError || error.name === 'SubcommandNotEnabledError') {
        console.log(`  PASS  ${shown} refused (${error.setting})`);
      } else {
        console.log(`  FAIL  ${shown} threw ${error.name}, not the push refusal: ${error.message}`);
        failures += 1;
      }
    }
  }

  // The control: a subcommand that is not guarded must still work, or the probe
  // would pass just as well against a runner that refuses everything.
  try {
    const result = await runner.run('git', ['--version'], { cwd });
    if (/git version/.test(result.stdout)) {
      console.log('  PASS  git --version still runs (the guard is specific, not a blanket)');
    } else {
      console.log(`  FAIL  git --version returned unexpected output: ${result.stdout.trim()}`);
      failures += 1;
    }
  } catch (error) {
    console.log(`  FAIL  git --version was refused too: ${error.message}`);
    failures += 1;
  }

  fs.rmSync(cwd, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\nPUSH PROBE FAILED (${failures} attempt(s) not refused)`);
    process.exit(1);
  }
  console.log(`\nPUSH PROBE PASSED (${ATTEMPTS.length + 1} checks against backend/dist)`);
}

main().catch((error) => {
  console.error(`probe error: ${error.stack}`);
  process.exit(1);
});
