import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// YUK-274 — `src/server/boss/client.ts` caches its PgBoss singleton (instance +
// start promise) on globalThis so that `next dev` HMR (which re-evaluates the
// module on every recompile) reuses one started boss instead of orphaning the
// previous one's timekeeper timers + pg.Pool each reload (observed 2026-06-07:
// pgboss connection count grew 2→4 per recompile). These tests pin that contract
// WITHOUT a live Postgres: `pg-boss` is vi.mock'd to a constructor that counts
// instantiations, and the module is re-imported via vi.resetModules() to
// simulate an HMR re-evaluation. The ONLY import of `./client` here is the
// DYNAMIC `await import()` below (no static boss/db import), and the static
// `pg-boss` import is mocked — so the partition auditor sees zero unmocked DB
// imports and this file stays in the unit partition (mirrors the YUK-263
// src/db/client.test.ts pattern). The live-DB round-trip + SEND_IT race tests
// stay in the sibling client.test.ts (db partition).

let instanceCount = 0;
class MockPgBoss {
  constructor(_opts: unknown) {
    instanceCount += 1;
  }
  // getStartedBoss() calls boss.start(); resolve so the start promise settles.
  start = vi.fn(async () => undefined);
}

vi.mock('pg-boss', () => ({ PgBoss: MockPgBoss }));

const GLOBAL_KEY = '__loomBossState' as const;

type GlobalWithBossCache = typeof globalThis & {
  [GLOBAL_KEY]?: unknown;
};

function clearGlobalCache(): void {
  delete (globalThis as GlobalWithBossCache)[GLOBAL_KEY];
}

describe('src/server/boss/client globalThis singleton cache (YUK-274)', () => {
  beforeEach(() => {
    instanceCount = 0;
    vi.resetModules();
    clearGlobalCache();
    // Value is irrelevant — PgBoss is mocked and never opens a socket. vi.stubEnv
    // is used (not direct assignment) because process.env.NODE_ENV is typed
    // read-only in this repo.
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/loom_test');
  });

  afterEach(() => {
    // Restores NODE_ENV / DATABASE_URL / VITEST; scrub the global so no boss-state
    // sentinel leaks into sibling tests.
    vi.unstubAllEnvs();
    clearGlobalCache();
    vi.resetModules();
  });

  it('reuses the globalThis-cached instance across module re-evaluations outside production (HMR path)', async () => {
    vi.stubEnv('NODE_ENV', 'test');

    const first = await import('./client');
    const boss1 = first.createBoss();
    expect(instanceCount).toBe(1);
    expect((globalThis as GlobalWithBossCache)[GLOBAL_KEY]).toBeDefined();

    // Simulate an HMR recompile: drop the module cache and re-import. The second
    // evaluation must read the globalThis-cached state, NOT construct a new boss.
    vi.resetModules();
    const second = await import('./client');
    const boss2 = second.createBoss();
    expect(instanceCount).toBe(1);
    // Same underlying instance survives the reload.
    expect(boss2).toBe(boss1);
  });

  it('does not write globalThis.__loomBossState in production (no HMR → module cache suffices)', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const mod = await import('./client');
    mod.createBoss();
    expect(instanceCount).toBe(1);
    expect((globalThis as GlobalWithBossCache)[GLOBAL_KEY]).toBeUndefined();

    // A second evaluation in production gets no cache to fall back on, so it
    // constructs a fresh instance — but it still never writes to globalThis.
    vi.resetModules();
    const mod2 = await import('./client');
    mod2.createBoss();
    expect(instanceCount).toBe(2);
    expect((globalThis as GlobalWithBossCache)[GLOBAL_KEY]).toBeUndefined();
  });

  it('rebuilds the instance after _resetBossForTests()', async () => {
    vi.stubEnv('NODE_ENV', 'test');

    const mod = await import('./client');
    const boss1 = mod.createBoss();
    expect(instanceCount).toBe(1);

    // Reset clears the cached state; the next createBoss() must construct anew.
    mod._resetBossForTests();
    const boss2 = mod.createBoss();
    expect(instanceCount).toBe(2);
    expect(boss2).not.toBe(boss1);
  });
});
