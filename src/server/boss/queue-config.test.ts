// YUK-576 — queue-level explicit retry policy for the DLQ-backed llm/agent tiers.
//
// Pure no-DB unit: pg-boss is vi.mock'd (queue-config transitively imports
// @/server/boss/client which imports the PgBoss class at module top) and the
// "boss" handed to createJobQueue/createOrUpdateQueue is a plain capture fake —
// no live Postgres / no live PgBoss instance. The ONLY ./queue-config import is
// a dynamic `await import()` (client.globalthis.test.ts precedent), which is
// what audit:partition's file-level P0 check sanctions for a unit test touching
// the DB-tainted src/server/boss/ dir with the taint root (pg-boss) mocked.
// MUST be enumerated in fastTestInclude (vitest.shared.ts): src/server/boss/**
// has no unit glob.
//
// Ground (design doc §6): pg-boss v12 persists queue-level retryLimit in the
// queue options JSON with COALESCE(..., 2) — the implicit default ALREADY
// redelivers twice. Making it explicit (retryLimit: 2) is a zero-count change;
// the delta is retryDelay: 30 + retryBackoff: true (defaults 0/false → immediate
// redelivery today), giving transient conditions time to recover before the
// next paid attempt. Mirrors the memory queue's send-time triplet
// (src/server/memory/triggers.ts:294).

import { describe, expect, it, vi } from 'vitest';

vi.mock('pg-boss', () => ({ PgBoss: class {} }));

// Dynamic import (NOT static) — see partition note in the header.
const { EXPIRE_AGENT, EXPIRE_LLM, FAST_QUEUE_OPTS, createJobQueue } = await import(
  './queue-config'
);

interface CapturedCall {
  method: 'createQueue' | 'updateQueue';
  name: string;
  opts: Record<string, unknown>;
}

function captureBoss() {
  const calls: CapturedCall[] = [];
  const boss = {
    createQueue: async (name: string, opts: Record<string, unknown>) => {
      calls.push({ method: 'createQueue', name, opts });
    },
    updateQueue: async (name: string, opts: Record<string, unknown>) => {
      calls.push({ method: 'updateQueue', name, opts });
    },
  };
  return { boss: boss as never, calls };
}

describe('createJobQueue — explicit queue-level retry policy (YUK-576)', () => {
  it.each([
    { tier: 'llm', expire: EXPIRE_LLM },
    { tier: 'agent', expire: EXPIRE_AGENT },
  ])('$tier tier main queue carries retryLimit/retryDelay/retryBackoff', async ({ expire }) => {
    const { boss, calls } = captureBoss();

    await createJobQueue(boss, 'some_queue', expire);

    const mainCreates = calls.filter((c) => c.name === 'some_queue');
    expect(mainCreates.length).toBeGreaterThan(0);
    for (const call of mainCreates) {
      // Explicit 2 = pg-boss's implicit default count (zero behavior-count change);
      // 30s + backoff = the deliberate delta (was immediate redelivery).
      expect(call.opts.retryLimit).toBe(2);
      expect(call.opts.retryDelay).toBe(30);
      expect(call.opts.retryBackoff).toBe(true);
      // Pre-existing YUK-237 config must be preserved alongside.
      expect(call.opts.expireInSeconds).toBe(expire);
      expect(call.opts.deadLetter).toBe('some_queue_dlq');
    }
    // createQueue AND updateQueue must use the SAME opts (lockstep reconcile).
    const createOpts = mainCreates.find((c) => c.method === 'createQueue')?.opts;
    const updateOpts = mainCreates.find((c) => c.method === 'updateQueue')?.opts;
    expect(updateOpts).toEqual(createOpts);
  });

  it('the DLQ keeps FAST_QUEUE_OPTS (no retry policy — it never runs a worker)', async () => {
    const { boss, calls } = captureBoss();

    await createJobQueue(boss, 'some_queue', EXPIRE_LLM);

    const dlqCalls = calls.filter((c) => c.name === 'some_queue_dlq');
    expect(dlqCalls.length).toBeGreaterThan(0);
    for (const call of dlqCalls) {
      expect(call.opts).toEqual(FAST_QUEUE_OPTS);
      expect('retryLimit' in call.opts).toBe(false);
    }
  });
});
