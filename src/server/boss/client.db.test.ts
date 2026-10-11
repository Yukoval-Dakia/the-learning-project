import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// YUK-1359 — constructor-option mapping for the RW_BOSS_AUTOMATION seam.
// PgBoss is mocked so tests assert the exact config object passed to the real
// constructor without a database; start() is controllable for the cached
// promise / error-reset semantics of getStartedBoss.
const { ctorArgs, startOutcome } = vi.hoisted(() => ({
  ctorArgs: [] as Record<string, unknown>[],
  startOutcome: { error: null as unknown },
}));

vi.mock('pg-boss', () => ({
  PgBoss: class MockPgBoss {
    constructor(config: Record<string, unknown>) {
      ctorArgs.push(config);
    }
    async start() {
      if (startOutcome.error) throw startOutcome.error;
      return this;
    }
    async stop() {}
  },
  fromDrizzle: () => ({}),
}));

import {
  _resetBossForTests,
  createBoss,
  getRunningBoss,
  getStartedBoss,
} from '@/server/boss/client';
import { createServerEnv, resolveBossAutomationMode } from '@/server/env';

const TEST_DATABASE_URL = 'postgres://unit:test@127.0.0.1:5432/unit';
const ENV_KEYS = ['DATABASE_URL', 'RW_BOSS_AUTOMATION'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  _resetBossForTests();
  ctorArgs.length = 0;
  startOutcome.error = null;
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  delete process.env.RW_BOSS_AUTOMATION;
});

afterEach(() => {
  _resetBossForTests();
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  savedEnv.clear();
});

describe('resolveBossAutomationMode', () => {
  it('resolves enabled when unset, empty, or explicit', () => {
    expect(resolveBossAutomationMode(undefined)).toBe('enabled');
    expect(resolveBossAutomationMode('')).toBe('enabled');
    expect(resolveBossAutomationMode('enabled')).toBe('enabled');
  });

  it('resolves disabled only for the explicit typed value', () => {
    expect(resolveBossAutomationMode('disabled')).toBe('disabled');
  });

  it('rejects values outside the typed mode', () => {
    expect(() => resolveBossAutomationMode('off')).toThrow(/RW_BOSS_AUTOMATION/);
    expect(() => resolveBossAutomationMode('0')).toThrow(/RW_BOSS_AUTOMATION/);
    expect(() => resolveBossAutomationMode('true')).toThrow(/RW_BOSS_AUTOMATION/);
  });

  it('createServerEnv validation also rejects a non-enum value', () => {
    expect(() =>
      createServerEnv({ DATABASE_URL: TEST_DATABASE_URL, RW_BOSS_AUTOMATION: 'bogus' }, false),
    ).toThrow();
  });
});

describe('createBoss', () => {
  it('constructs PgBoss with only connection/schema by default — automation flags untouched', () => {
    createBoss();
    expect(ctorArgs).toHaveLength(1);
    // Under vitest the pool cap is applied (VITEST env is always set); no
    // automation flag is passed so the library defaults (all true) stand.
    expect(ctorArgs[0]).toEqual({
      connectionString: TEST_DATABASE_URL,
      schema: 'pgboss',
      max: 2,
    });
  });

  it('explicit enabled mode constructs the identical config', () => {
    createBoss();
    const defaultConfig = ctorArgs[0];
    _resetBossForTests();
    ctorArgs.length = 0;
    process.env.RW_BOSS_AUTOMATION = 'enabled';
    createBoss();
    expect(ctorArgs[0]).toEqual(defaultConfig);
  });

  it('maps disabled mode to schedule/supervise/migrate/registerInstance all false', () => {
    process.env.RW_BOSS_AUTOMATION = 'disabled';
    createBoss();
    expect(ctorArgs[0]).toEqual({
      connectionString: TEST_DATABASE_URL,
      schema: 'pgboss',
      schedule: false,
      supervise: false,
      migrate: false,
      registerInstance: false,
      max: 2,
    });
  });

  it('returns the singleton on repeat calls', () => {
    expect(createBoss()).toBe(createBoss());
    expect(ctorArgs).toHaveLength(1);
  });

  it('rejects an invalid mode without constructing the boss', () => {
    process.env.RW_BOSS_AUTOMATION = 'bogus';
    expect(() => createBoss()).toThrow(/RW_BOSS_AUTOMATION/);
    expect(ctorArgs).toHaveLength(0);
    process.env.RW_BOSS_AUTOMATION = 'enabled';
    expect(() => createBoss()).not.toThrow();
    expect(ctorArgs).toHaveLength(1);
  });
});

describe('getStartedBoss', () => {
  it('starts the disabled-mode singleton once and caches it as running', async () => {
    process.env.RW_BOSS_AUTOMATION = 'disabled';
    const boss = await getStartedBoss();
    expect(boss).toBe(createBoss());
    expect(getRunningBoss()).toBe(boss);
    await expect(getStartedBoss()).resolves.toBe(boss);
  });

  it('clears the cached start promise on failure so a later call retries', async () => {
    startOutcome.error = new Error('connection refused');
    await expect(getStartedBoss()).rejects.toThrow('connection refused');
    startOutcome.error = null;
    await expect(getStartedBoss()).resolves.toBe(createBoss());
  });

  it('swallows the benign 23505 internal queue-create race and still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startOutcome.error = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(getStartedBoss()).resolves.toBe(createBoss());
    expect(getRunningBoss()).toBe(createBoss());
    warn.mockRestore();
  });
});
