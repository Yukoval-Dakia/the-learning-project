// YUK-572 PR-2 — agent-nightly job unit tests. Hermetic (no DB / AI): the claim gate's
// event store is an injected in-memory Map, and the director is a stub. Asserts the two
// job-level guards — the RESEARCH_MEETING_AGENT_ENABLED kill switch and the dayKey
// nonce-claim idempotency — WITHOUT touching Postgres.

import type { WriteEventInput } from '@/server/events/queries';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentNightlyDeps,
  RESEARCH_MEETING_AGENT_ENABLED_ENV,
  buildResearchMeetingAgentNightlyHandler,
  runResearchMeetingAgentNightly,
} from './research_meeting_agent_nightly';

// An in-memory event store for the claim gate: writeEventFn does first-write-wins on id
// (mirroring writeEvent's onConflictDoNothing), readEventByIdFn reads it back.
function memoryEventStore() {
  const store = new Map<string, { payload: unknown }>();
  const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => {
    if (!store.has(input.id)) store.set(input.id, { payload: input.payload });
    return input.id;
  });
  const readEventByIdFn = vi.fn(async (_db: unknown, id: string) => store.get(id) ?? null);
  return { store, writeEventFn, readEventByIdFn };
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
  const { writeEventFn, readEventByIdFn } = memoryEventStore();
  return {
    now: () => new Date('2026-07-06T21:00:00Z'), // 05:00 BJT next day → dayKey 2026-07-07
    writeEventFn,
    readEventByIdFn,
    runDirectorFn: vi.fn(async () => directorResult()),
    ...overrides,
  };
}

describe('runResearchMeetingAgentNightly — dayKey claim idempotency', () => {
  it('runs the director once when it wins the day claim', async () => {
    const runDirectorFn = vi.fn(async () => directorResult());
    const d = deps({ runDirectorFn });
    const result = await runResearchMeetingAgentNightly({} as never, d);
    expect(result.skipped).toBe(false);
    expect(result.day_key).toBe('2026-07-07');
    expect(runDirectorFn).toHaveBeenCalledTimes(1);
  });

  it('skips the director on a same-day retry (claim already exists)', async () => {
    const runDirectorFn = vi.fn(async () => directorResult());
    // Share ONE event store across both calls (a pg-boss retry hits the same DB).
    const store = memoryEventStore();
    const shared: AgentNightlyDeps = {
      now: () => new Date('2026-07-06T21:00:00Z'),
      writeEventFn: store.writeEventFn,
      readEventByIdFn: store.readEventByIdFn,
      runDirectorFn,
    };
    const first = await runResearchMeetingAgentNightly({} as never, shared);
    const second = await runResearchMeetingAgentNightly({} as never, shared);
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already_claimed_today');
    expect(runDirectorFn).toHaveBeenCalledTimes(1); // never re-runs → no re-spend
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

  it('early-returns for any value other than the exact string "1"', async () => {
    process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV] = 'true';
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
