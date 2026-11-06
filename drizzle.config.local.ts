import { defineConfig } from 'drizzle-kit';
import { buildLocalDatabaseUrl, guardLocalDbTarget } from './scripts/local-db-env';

// Local-only drizzle config for manual `drizzle-kit --config drizzle.config.local.ts`
// runs. Resolves the same target as db:migrate:local — the worktree dev database
// (docker-compose.dev.yml :5434) — and refuses TEST targets before connecting.
guardLocalDbTarget('drizzle.config.local');

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
