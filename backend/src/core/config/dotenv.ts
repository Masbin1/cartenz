import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader.
 *
 * The repository root .env is the single environment file for both the API and
 * the worker, so that the two processes cannot drift apart. Values already
 * present in the process environment always win, which is what allows Compose,
 * Kubernetes and CI to supply configuration without a file being present.
 *
 * Written rather than taken as a dependency because the requirement is a dozen
 * lines and the file is read exactly once, at boot, before anything else runs.
 */
export function loadDotEnv(candidatePaths: readonly string[]): void {
  for (const candidate of candidatePaths) {
    let contents: string;
    try {
      contents = readFileSync(resolve(candidate), 'utf8');
    } catch {
      continue;
    }
    applyEnvFile(contents);
    return;
  }
}

function applyEnvFile(contents: string): void {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    if (key in process.env) continue;

    let value = line.slice(separator + 1).trim();
    const doubleQuoted = value.startsWith('"') && value.endsWith('"');
    const singleQuote = String.fromCharCode(39);
    const singleQuoted = value.startsWith(singleQuote) && value.endsWith(singleQuote);
    if (value.length >= 2 && (doubleQuoted || singleQuoted)) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

/**
 * Standard search order for the environment file: the process working
 * directory, then the repository root relative to backend/. Both entry points
 * call this before reading configuration.
 */
export function loadDefaultDotEnv(): void {
  loadDotEnv(['.env', '../.env', '../../.env']);
}
