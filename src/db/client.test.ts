import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// YUK-263 — `src/db/client.ts` caches its postgres-js pool on globalThis so that
// `next dev` HMR (which re-evaluates the module on every recompile) reuses one
// pool instead of leaking a fresh one each reload. These tests pin that contract
// WITHOUT a live Postgres: `postgres` is vi.mock'd to a factory that returns a
// sentinel and counts calls, and the module is re-imported via vi.resetModules()
// to simulate HMR re-evaluation. Because the only import of `@/db/client` here is
// the DYNAMIC `await import()` below (no static DB import), this file stays in the
// unit partition (see vitest.shared fastTestInclude). `drizzle-orm/postgres-js`
// is left real — it only wraps the (mocked) client and opens no connection.

const postgresFactory = vi.fn(() => ({ __mockPostgresClient: true }));
vi.mock('postgres', () => ({ default: postgresFactory }));

// `drizzle()` introspects the real client (e.g. `.options.parsers`); since the
// mocked client is a bare sentinel, stub the wrapper to a passthrough. The cache
// behaviour under test lives entirely in client.ts before drizzle() is reached.
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn((client: unknown) => ({ __mockDrizzleDb: true, client })),
}));

const GLOBAL_KEY = '__loomQueryClient' as const;

type GlobalWithDbCache = typeof globalThis & {
  [GLOBAL_KEY]?: unknown;
};

function clearGlobalCache(): void {
  delete (globalThis as GlobalWithDbCache)[GLOBAL_KEY];
}

describe('src/db/client globalThis pool cache (YUK-263)', () => {
  beforeEach(() => {
    postgresFactory.mockClear();
    vi.resetModules();
    clearGlobalCache();
    // Local URL → SSL disabled; the value is otherwise irrelevant since postgres()
    // is mocked and never opens a socket. vi.stubEnv is used (not direct
    // assignment) because process.env.NODE_ENV is typed read-only in this repo.
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/loom_test');
  });

  afterEach(() => {
    // vi.unstubAllEnvs restores NODE_ENV / DATABASE_URL (true-removing vars that
    // were unset); scrub the global so no pool sentinel leaks into sibling tests.
    vi.unstubAllEnvs();
    clearGlobalCache();
    vi.resetModules();
  });

  it('reuses the cached pool across module re-evaluations outside production (HMR path)', async () => {
    vi.stubEnv('NODE_ENV', 'test');

    await import('@/db/client');
    expect(postgresFactory).toHaveBeenCalledTimes(1);
    expect((globalThis as GlobalWithDbCache)[GLOBAL_KEY]).toBeDefined();

    // Simulate an HMR recompile: drop the module cache and re-import. The second
    // evaluation must read the globalThis-cached pool, NOT call postgres() again.
    vi.resetModules();
    await import('@/db/client');
    expect(postgresFactory).toHaveBeenCalledTimes(1);
  });

  it('does not pollute globalThis in production (no HMR → module cache suffices)', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await import('@/db/client');
    expect(postgresFactory).toHaveBeenCalledTimes(1);
    expect((globalThis as GlobalWithDbCache)[GLOBAL_KEY]).toBeUndefined();

    // A second evaluation in production gets no cache to fall back on, so it
    // constructs a fresh pool — but it still never writes to globalThis.
    vi.resetModules();
    await import('@/db/client');
    expect(postgresFactory).toHaveBeenCalledTimes(2);
    expect((globalThis as GlobalWithDbCache)[GLOBAL_KEY]).toBeUndefined();
  });
});
