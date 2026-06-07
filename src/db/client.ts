import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Fail fast on missing DATABASE_URL. Empty-string fallback (`?? ''`) would let the
// module load and defer the failure until the first query hits postgres-js, which
// surfaces a confusing "tcp connect to ''" error far from the root cause.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Configure it in .env.local locally, or in the docker-compose .env file for NAS/self-hosted runtime.',
  );
}

// Singleton client. In the standalone app container and the worker process,
// this module is cached per Node process; postgres-js handles pooling.
// In `next dev`, HMR re-evaluates this module on every recompile — without a
// globalThis cache each re-evaluation calls postgres() again and leaks a fresh
// pool that nobody end()s (observed 2026-06-07: 97/100 Postgres connections
// idle after ~207 recompiles, starving every API route into 3–11s stalls).
// Cache the pool on globalThis outside production so it survives module reloads;
// production (standalone container / worker) has no HMR, so the module cache
// alone suffices and we never write to globalThis there — behaviour unchanged.
// Disable SSL for local/test connections (localhost or 127.0.0.1) so testcontainers
// and local dev containers work without a TLS certificate. Also honour an
// explicit `sslmode=disable` in the URL — the option object otherwise wins over
// URL params, which silently breaks docker-compose-internal hostnames like
// `postgres:5432`.
const isLocalConnection = /localhost|127\.0\.0\.1/.test(databaseUrl);
const hasSslDisable = /[?&]sslmode=disable\b/.test(databaseUrl);
const globalForDb = globalThis as typeof globalThis & {
  __loomQueryClient?: ReturnType<typeof postgres>;
};
const queryClient =
  globalForDb.__loomQueryClient ??
  postgres(databaseUrl, {
    ssl: isLocalConnection || hasSslDisable ? false : 'require',
    max: 10, // pool size per app/worker process
  });
if (process.env.NODE_ENV !== 'production') {
  globalForDb.__loomQueryClient = queryClient;
}

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;

/**
 * Transaction handle (the argument passed to `db.transaction(async (tx) => …)`).
 * 与 `Db` 的查询/写入 API 完全一致，但**不**含 `$client`（raw postgres-js client）。
 * 模块需要在调用方事务内做写入时（如 `writeJobEvent` / `IngestionSession.*`），
 * 接收类型 `Tx | Db` 同时支持两种调用方式。
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
