import type { Config } from 'drizzle-kit';

/**
 * Drizzle Kit configuration. Migrations are generated into backend/drizzle and
 * applied by src/core/database/migrate.ts, which is what both the Compose entry
 * point and the local dev script call. Migrations are never applied implicitly
 * on API boot.
 */
export default {
  schema: './src/core/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
} satisfies Config;
