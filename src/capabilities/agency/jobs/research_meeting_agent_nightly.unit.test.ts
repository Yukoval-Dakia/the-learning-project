// YUK-572 PR-2 — agent-nightly job unit tests. Hermetic (no DB / AI): the claim gate's
// event store is an injected in-memory Map, and the director is a stub. Asserts the two
// job-level guards — the RESEARCH_MEETING_AGENT_ENABLED kill switch and the dayKey
// nonce-claim idempotency — WITHOUT touching Postgres.

import {
  RESEARCH_MEETING_AGENT_ACTOR,
  SCAN_ACTION,
} from '@/capabilities/agency/server/meeting/director';
import type { WriteEventInput } from '@/kernel/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentNightlyDeps,
  CLAIM_ACTION,
  RESEARCH_MEETING_AGENT_ENABLED_ENV,
  buildResearchMeetingAgentNightlyHandler,
  runResearchMeetingAgentNightly,
} from './research_meeting_agent_nightly';

const DAY_KEY = '2026-07-07'; // dayKey for the fixed `now` used across these tests.
const CLAIM_EVENT_ID = `research_meeting_agent_claim:${DAY_KEY}`;

// An in-memory event store for the claim gate: writeEventFn does first-write-wins on id
// (mirroring writeEvent's onConflictDoNothing), readEventByIdFn reads it back, and
// hasScanEventForDayFn scans the store for a SCAN_ACTION row carrying this dayKey — the
// same invariant the real defaultHasScanEventForDay queries in Postgres (§2 review fix).
function memoryEventStore() {
  const store = new Map<string, WriteEventInput>();
  const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => {
    if (!store.has(input.id)) store.set(input.id, input);
    return input.id;
  });
  const readEventByIdFn = vi.fn(async (_db: unknown, id: string) => {
    const rec = store.get(id);
    return rec ? { payload: rec.payload } : null;
  });
  const hasScanEventForDayFn = vi.fn(async (_db: unknown, dayKey: string) => {
    for (const rec of store.values()) {
      if (rec.action !== SCAN_ACTION) continue;
      const p = rec.payload as { day_key?: string } | undefined;
      if (p?.day_key === dayKey) return true;
    }
    return false;
  });
  return { store, writeEventFn, readEventByIdFn, hasScanEventForDayFn };
}

function directorResult() {
  return {
    proposals_created: 1,
    notes_created: 0,
    scout_spawned: 0,
    cost_usd: 0.05,
    task_run_id: 'director_run_1',
    trigger_event_id: 'trigger_1',
    outcome: 'success' as const,
  };
}

function deps(overrides: Partial<AgentNightlyDeps> = {}): AgentNightlyDeps {
  const { writeEventFn, readEventByIdFn, hasScanEventForDayFn } = memoryEventStore();
  return {
    now: () => new Date('2026-07-06T21:00:00Z'), // 05:00 BJT next day → dayKey 2026-07-07
    writeEventFn,
    readEventByIdFn,
    hasScanEventForDayFn,
    runDirectorFn: vi.fn(async () => directorResult()),
    ...overrides,
  };
}

/** Seed a pre-existing claim event directly into a store (simulating a PRIOR run that
 *  already won today's claim, without going through claimDay itself). */
async function seedClaim(store: ReturnType<typeof memoryEventStore>): Promise<void> {
  await store.writeEventFn({} as never, {
    id: CLAIM_EVENT_ID,
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
    action: CLAIM_ACTION,
    subject_kind: 'query',
    subject_id: CLAIM_EVENT_ID,
    outcome: null,
    payload: { claim_nonce: 'stale-nonce-from-a-prior-run', day_key: DAY_KEY },
    cost_micro_usd: null,
  });
}

/** Seed a scan event for today directly into a store (simulating a director run that
 *  reached its own completion marker — success or degraded, director.ts always writes
 *  one). */
async function seedScan(store: ReturnType<typeof memoryEventStore>): Promise<void> {
  await store.writeEventFn({} as never, {
    id: 'research_meeting_agent_scan_prior',
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
    action: SCAN_ACTION,
    subject_kind: 'query',
    subject_id: 'trigger_prior',
    outcome: 'success',
    payload: { day_key: DAY_KEY },
    cost_micro_usd: null,
  });
}

describe('runResearchMeetingAgentNightly — dayKey claim idempotency', () => {
  it('runs the director once when it wins the day claim', async () => {
    const runDirectorFn = vi.fn(async () => directorResult());
    const d = deps({ runDirectorFn });
    const result = await runResearchMeetingAgentNightly({} as never, d);
    expect(result.skipped).toBe(false);
    expect(result.day_key).toBe(DAY_KEY);
    expect(runDirectorFn).toHaveBeenCalledTimes(1);
  });

  it('skips the director on a same-day retry (claim already exists AND a scan event landed — complete prior run)', async () => {
    const store = memoryEventStore();
    // Mirror the REAL director invariant (director.ts): it ALWAYS writes a scan event on
    // completion (success or degraded). The stub does too, so the SECOND call's
    // claim+scan check (§2 review fix) correctly classifies this as a COMPLETE prior run
    // rather than an orphaned one.
    const runDirectorFn = vi.fn(async (db: unknown) => {
      await seedScan(store);
      void db;
      return directorResult();
    });
    const shared: AgentNightlyDeps = {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn: store.writeEventFn,
      readEventByIdFn: store.readEventByIdFn,
      hasScanEventForDayFn: store.hasScanEventForDayFn,
      runDirectorFn,
    };
    const first = await runResearchMeetingAgentNightly({} as never, shared);
    const second = await runResearchMeetingAgentNightly({} as never, shared);
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already_claimed_today');
    expect(runDirectorFn).toHaveBeenCalledTimes(1); // never re-runs → no re-spend
  });

  it('skips the director on a CONCURRENT redeliver: the existence check races past null, but a foreign winner nonce already landed by read-back (nonce-mismatch branch)', async () => {
    // Simulates two "simultaneous" claimants: both pass the existence check as null
    // (neither has committed yet), both attempt to write their own claim, but only
    // ONE nonce actually persists (onConflictDoNothing first-write-wins in the real
    // DB). THIS run's own write attempt lost that race — so when it reads back the
    // row, it sees a DIFFERENT (winner's) nonce, not its own. That mismatch is the
    // ONLY guard for the concurrent-redeliver window (the sequential-retry test
    // above never reaches this branch — its existence check already short-circuits
    // to `false` before any write is attempted).
    let readCalls = 0;
    const readEventByIdFn = vi.fn(async () => {
      readCalls += 1;
      if (readCalls === 1) return null; // existence check: not yet claimed (race window)
      // persisted read-back: a concurrent winner's row already landed with a
      // DIFFERENT nonce than the one THIS run generated for its own write.
      return { payload: { claim_nonce: 'winner-nonce-from-another-worker' } };
    });
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const runDirectorFn = vi.fn(async () => directorResult());

    const result = await runResearchMeetingAgentNightly(
      {} as never,
      deps({ readEventByIdFn, writeEventFn, runDirectorFn }),
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already_claimed_today');
    expect(runDirectorFn).not.toHaveBeenCalled(); // the loser never spends
    expect(writeEventFn).toHaveBeenCalledTimes(1); // this run DID attempt an insert (lost it)
    expect(writeEventFn.mock.calls[0][1].ingest_at).toEqual(new Date('2026-07-06T21:00:00Z'));
    expect(readEventByIdFn).toHaveBeenCalledTimes(2); // existence check + persisted read-back
  });

  it('pins the director run to the claim timestamp (shared now)', async () => {
    let seenNow: Date | undefined;
    const runDirectorFn = vi.fn(async (_db: unknown, injected: AgentNightlyDeps) => {
      seenNow = injected.now?.();
      return directorResult();
    });
    await runResearchMeetingAgentNightly({} as never, deps({ runDirectorFn }));
    expect(seenNow?.toISOString()).toBe('2026-07-06T21:00:00.000Z');
  });
});

describe('runResearchMeetingAgentNightly — orphaned-claim recovery (§2 review fix, MAJOR)', () => {
  it('re-runs the director when a claim exists but NO scan event landed (prior PRE-LLM segment failure — zero spend so far, safe to retry)', async () => {
    const store = memoryEventStore();
    // Pre-seed a claim as if a PRIOR invocation won it, then threw during its PRE-LLM
    // reads (director.ts) — BEFORE ever reaching the director's own trigger/scan event
    // writes. Zero spend occurred on that attempt; this run must be allowed to retry
    // rather than permanently masking the failure as `skipped: true`.
    await seedClaim(store);
    const runDirectorFn = vi.fn(async () => directorResult());
    const result = await runResearchMeetingAgentNightly({} as never, {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn: store.writeEventFn,
      readEventByIdFn: store.readEventByIdFn,
      hasScanEventForDayFn: store.hasScanEventForDayFn, // no scan seeded → orphaned claim
      runDirectorFn,
    });
    expect(result.skipped).toBe(false);
    expect(runDirectorFn).toHaveBeenCalledTimes(1);
  });

  it('skips when a claim exists AND a scan event for today already landed (complete prior run)', async () => {
    const store = memoryEventStore();
    await seedClaim(store);
    await seedScan(store);
    const runDirectorFn = vi.fn(async () => directorResult());
    const result = await runResearchMeetingAgentNightly({} as never, {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn: store.writeEventFn,
      readEventByIdFn: store.readEventByIdFn,
      hasScanEventForDayFn: store.hasScanEventForDayFn,
      runDirectorFn,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already_claimed_today');
    expect(runDirectorFn).not.toHaveBeenCalled();
  });
});

describe('runResearchMeetingAgentNightly — director deps hygiene (§8 review fix)', () => {
  it('does not leak job-only fields (runDirectorFn / readEventByIdFn / hasScanEventForDayFn) into the director deps', async () => {
    let seenDeps: AgentNightlyDeps | undefined;
    const runDirectorFn = vi.fn(async (_db: unknown, injected: AgentNightlyDeps) => {
      seenDeps = injected;
      return directorResult();
    });
    await runResearchMeetingAgentNightly({} as never, deps({ runDirectorFn }));
    expect(seenDeps).toBeDefined();
    expect(seenDeps).not.toHaveProperty('runDirectorFn');
    expect(seenDeps).not.toHaveProperty('readEventByIdFn');
    expect(seenDeps).not.toHaveProperty('hasScanEventForDayFn');
  });
});

describe('buildResearchMeetingAgentNightlyHandler — kill switch', () => {
  beforeEach(() => {
    delete process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV];
  });
  afterEach(() => {
    delete process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV];
  });

  it('early-returns with the flag unset: zero director calls, zero claim writes', async () => {
    const runDirectorFn = vi.fn(async () => directorResult());
    const { writeEventFn, readEventByIdFn } = memoryEventStore();
    const handler = buildResearchMeetingAgentNightlyHandler({} as never, {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn,
      readEventByIdFn,
      runDirectorFn,
    });
    await handler([]);
    expect(runDirectorFn).not.toHaveBeenCalled();
    expect(writeEventFn).not.toHaveBeenCalled(); // no claim event, zero spend
  });

  it('early-returns for an unrecognized literal', async () => {
    process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV] = 'yes';
    const runDirectorFn = vi.fn(async () => directorResult());
    const { writeEventFn, readEventByIdFn } = memoryEventStore();
    const handler = buildResearchMeetingAgentNightlyHandler({} as never, {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn,
      readEventByIdFn,
      runDirectorFn,
    });
    await handler([]);
    expect(runDirectorFn).not.toHaveBeenCalled();
  });

  it('runs when the flag is exactly "1"', async () => {
    process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV] = '1';
    const runDirectorFn = vi.fn(async () => directorResult());
    const { writeEventFn, readEventByIdFn } = memoryEventStore();
    const handler = buildResearchMeetingAgentNightlyHandler({} as never, {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn,
      readEventByIdFn,
      runDirectorFn,
    });
    await handler([]);
    expect(runDirectorFn).toHaveBeenCalledTimes(1);
  });

  it('also runs for the shared case-insensitive "true" literal', async () => {
    process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV] = 'TRUE';
    const runDirectorFn = vi.fn(async () => directorResult());
    const { writeEventFn, readEventByIdFn } = memoryEventStore();
    const handler = buildResearchMeetingAgentNightlyHandler({} as never, {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn,
      readEventByIdFn,
      runDirectorFn,
    });
    await handler([]);
    expect(runDirectorFn).toHaveBeenCalledTimes(1);
  });

  it('rethrows a director failure so pg-boss retries (dayKey claim guards the re-run)', async () => {
    process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV] = '1';
    const runDirectorFn = vi.fn(async () => {
      throw new Error('pre-LLM read blew up');
    });
    const { writeEventFn, readEventByIdFn } = memoryEventStore();
    const handler = buildResearchMeetingAgentNightlyHandler({} as never, {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn,
      readEventByIdFn,
      runDirectorFn,
    });
    await expect(handler([])).rejects.toThrow('pre-LLM read blew up');
  });
});
