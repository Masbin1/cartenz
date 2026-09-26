#!/usr/bin/env node
/**
 * Frontend unit/component test runner.
 *
 * The portal has no Jest/Vitest setup, and adding one (plus jsdom and a React
 * Testing Library) for a handful of pure-logic and render tests would be a
 * large dependency footprint on a disk-constrained host. Instead each
 * `*.test.ts(x)` file is bundled with esbuild (already installed as a Next
 * dependency) and run with Node's built-in `node:test`.
 *
 * Component tests render with `react-dom/server` and assert on markup. That
 * covers what a component renders for a given state; interaction is tested
 * through the pure reducers/handlers the components call, not by simulating
 * DOM events.
 *
 *   npm test                    # every test under lib/ and components/
 *   npm test -- lib/office      # only files whose path contains the filter
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const filters = process.argv.slice(2);

function collect(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...collect(path));
    else if (/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

const files = ['lib', 'components']
  .flatMap((dir) => collect(join(root, dir)))
  .filter((file) => filters.length === 0 || filters.some((f) => relative(root, file).includes(f)))
  .sort();

if (files.length === 0) {
  console.error('No test files matched.');
  process.exit(1);
}

const outdir = mkdtempSync(join(tmpdir(), 'cartenz-frontend-tests-'));
try {
  const outputs = [];
  for (const file of files) {
    const outfile = join(outdir, `${relative(root, file).replace(/[\\/]/g, '__')}.cjs`);
    await build({
      entryPoints: [file],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      jsx: 'automatic',
      alias: { '@': root },
      // Resolve react et al. from the repo; they are not bundled so a single
      // React instance serves both the test and the component.
      packages: 'external',
      nodePaths: [join(root, 'node_modules'), join(root, '..', 'node_modules')],
      logLevel: 'warning',
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    outputs.push(outfile);
  }

  const result = spawnSync(process.execPath, ['--test', ...outputs], {
    stdio: 'inherit',
    cwd: root,
    env: {
      ...process.env,
      NODE_PATH: [join(root, 'node_modules'), join(root, '..', 'node_modules')].join(':'),
    },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
