import Redis from 'ioredis';

// Shared lazy ioredis singleton — one connection per process, reused across
// all calls. Mirrors the per-process singleton pattern of src/db/client.ts and
// src/server/boss/client.ts. The Next web process and the pg-boss worker
// process each create their own singleton but point at the SAME Redis server
// (REDIS_URL), which is how editing presence becomes cross-process (YUK-148).
//
// Connection is created lazily (lazyConnect) so importing this module never
// opens a socket; the first command triggers the connect. Callers that don't
// have REDIS_URL set never reach here (the presence factory falls back to the
// in-memory store), so this module assumes REDIS_URL is present.

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    // The presence factory guards on REDIS_URL before constructing the Redis
    // store, so this should be unreachable in practice. Throwing here surfaces
    // a misconfiguration loudly rather than silently opening localhost:6379.
    throw new Error('REDIS_URL is required to create a Redis client');
  }
  client = new Redis(url, {
    // Defer the TCP connect until the first command. Keeps module import
    // side-effect-free and lets the in-memory fallback path stay connection-free.
    lazyConnect: true,
    // Presence is best-effort ephemeral state; don't let a transient blip wedge
    // a route forever. A bounded retry keeps reconnects snappy.
    maxRetriesPerRequest: 3,
  });
  return client;
}

// Graceful shutdown — called from the worker's SIGTERM/SIGINT handler so the
// process can exit cleanly. No-op when no client was ever created.
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  await c.quit();
}

// Test-only reset so integration tests can dispose their own client between
// runs without leaking a connection into the next file.
export async function resetRedisClientForTests(): Promise<void> {
  await closeRedis();
}
