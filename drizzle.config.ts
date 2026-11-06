import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

import { guardDatabaseUrl } from './scripts/local-db-env';

config({ path: '.env.local' });

// db:generate / db:push / db:migrate read DATABASE_URL directly; refuse a
// loopback TEST target (port 5433/5544 or database `loom`) before connecting.
guardDatabaseUrl('drizzle.config');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
