import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Fail fast on missing DATABASE_URL. Empty-string fallback (`?? ''`) would let the
// module load and defer the failure until the first query hits postgres-js, which
// surfaces a confusing "tcp connect to ''" error far from the root cause.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Configure it in .env.local locally, or in Vercel env vars (auto-injected by the Neon integration).',
  );
}

// Singleton client. In Vercel functions, this module is cached across invocations
// within a hot container; postgres-js handles connection pooling per process.
const queryClient = postgres(databaseUrl, {
  ssl: 'require',
  max: 10, // pool size; per-Vercel-function cap
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
