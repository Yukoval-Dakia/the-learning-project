import { defineConfig } from 'drizzle-kit';
import { buildLocalDatabaseUrl } from './scripts/local-db-env';

// Local-only drizzle config (compose DB). Does NOT load .env.local
// (which points to Neon for runtime). Used by db:push:local + db:migrate:local
// equivalents to avoid drizzle-kit attempting to hit Neon during dev.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: buildLocalDatabaseUrl(process.env),
  },
  strict: true,
  verbose: true,
});
