import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Singleton client. In Vercel functions, this module is cached across invocations
// within a hot container; postgres-js handles connection pooling per process.
const queryClient = postgres(process.env.DATABASE_URL ?? '', {
  ssl: 'require',
  max: 10, // pool size; per-Vercel-function cap
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
