/**
 * Reports the push and GitHub posture of the deployment, from the compiled code.
 *
 * Two reasons this exists rather than trusting `grep .env`:
 *
 *  1. A key can be present and inert. `GITHUB_REPOSITORY_ENABLED=true` with an empty
 *     token or owner leaves repository creation *off*, and `GIT_AUTO_PUSH_ON_TASK` does
 *     nothing while `GIT_PUSH_ENABLED=false`. What matters is the folded outcome, not
 *     the lines in the file.
 *  2. The environment wins over the file. `loadDotEnv` skips a key already present in
 *     `process.env`, so a shell that has ever sourced `.env` pins those values and a
 *     later edit to the file is invisible in that shell. Run this from a clean shell
 *     (`env -i PATH="$PATH" node ...`) when checking an edit - otherwise you are
 *     reading the old values and concluding the edit did not land.
 *
 * Reads backend/dist, the same artefact the API and worker load. Prints nothing
 * secret: the token is reported as present or absent, never echoed.
 */
'use strict';

const path = require('node:path');

const DIST = path.resolve(__dirname, '../../backend/dist');

const { loadDefaultDotEnv } = require(path.join(DIST, 'core/config/dotenv.js'));
const { loadConfig } = require(path.join(DIST, 'core/config/configuration.js'));
const { resolveOnPremiseRepository } = require(
  path.join(DIST, 'agent/workspace/on-premise-repository.js'),
);

const ON_PREMISE_ROOT = process.env.ON_PREMISE_ROOT ?? '';
const projects = process.argv.slice(2);

loadDefaultDotEnv();

let config;
try {
  config = loadConfig();
} catch (error) {
  process.stderr.write(`Configuration would not load, so the API would not start:\n${error.message}\n`);
  process.exit(1);
}

process.stdout.write('Push and GitHub posture\n');
process.stdout.write(`  GIT_PUSH_ENABLED (any push at all)      : ${config.git.pushEnabled}\n`);
process.stdout.write(`  GIT_AUTO_PUSH_ON_TASK (no approval)     : ${config.git.autoPushOnTask}\n`);
process.stdout.write(`  GITHUB_REPOSITORY_ENABLED (effective)   : ${config.github.repositoryEnabled}\n`);
process.stdout.write(`  GITHUB_TOKEN                            : ${config.github.token ? 'set' : 'absent'}\n`);
process.stdout.write(`  GITHUB_OWNER                            : ${config.github.owner ?? 'absent'}\n`);
process.stdout.write(`  visibility                              : ${config.github.visibility}\n`);

if (!config.git.pushEnabled) {
  process.stdout.write(
    '\nA push is refused at the process layer: GIT_PUSH_ENABLED=false means no code path\n' +
      'can push, whatever permission, approval or GitHub setting is in force.\n',
  );
} else if (!config.github.repositoryEnabled) {
  process.stdout.write(
    '\nPushing works, but creating a repository for a new project does not: set\n' +
      'GITHUB_TOKEN and GITHUB_OWNER (both required) and restart cartenz-api and\n' +
      'cartenz-worker.\n',
  );
}

if (projects.length > 0) {
  process.stdout.write('\nThe repository each project directory would be operated on:\n');
  (async () => {
    for (const name of projects) {
      const selected = path.join(ON_PREMISE_ROOT, name);
      const resolved = await resolveOnPremiseRepository(selected);
      process.stdout.write(`  ${name}: ${resolved ?? 'not a git repository'}\n`);
    }
  })().catch((error) => {
    process.stderr.write(`Probe failed: ${error.message}\n`);
    process.exit(1);
  });
}
