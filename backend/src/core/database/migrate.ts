import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { loadDefaultDotEnv } from '../config/dotenv';
import { loadConfig } from '../config/configuration';

/**
 * Applies pending migrations and exits.
 *
 * Migrations are never applied implicitly on API boot: two API replicas starting
 * together would race, and a schema change would ship without anyone deciding
 * to apply it. Both the Compose entry point and the local dev script call this
 * explicitly before starting the API.
 */
async function main(): Promise<void> {
  loadDefaultDotEnv();
  const config = loadConfig();

  const pool = new Pool({
    connectionString: config.database.url,
    max: 1,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  });

  const db = drizzle(pool);
  const migrationsFolder = resolve(__dirname, '../../../drizzle');

  try {
    process.stdout.write(`Applying migrations from ${migrationsFolder}\n`);
    await migrate(db, { migrationsFolder });
    process.stdout.write('Migrations applied.\n');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${(error as Error).message}\n`);
  process.exit(1);
});
