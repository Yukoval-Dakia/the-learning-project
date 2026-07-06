// YUK-572 PR-2 §3 — agent-led 教研例会 nightly job (shadow lane, dark-ship).
//
// The pg-boss handler for the agent director lane. Structurally distinct from the
// deterministic research_meeting_nightly (which is the untouched control group): this
// runs the charter-agent director (runResearchMeetingDirector) behind two guards:
//
//   1. Kill switch RESEARCH_MEETING_AGENT_ENABLED — default OFF (dark-ship). The cron is
//      registered (the job exists) but the handler early-returns when the flag != '1':
//      zero spend, zero events, zero proposals. Flip = set the worker container .env +
//      restart (single-process, one env — no AI-provider three-process wiring here).
//
//   2. dayKey nonce-claim idempotency — a pg-boss retry (handler threw after the director
//      spent) must NOT re-run the director (re-burning Opus quota + re-proposing). A
//      deterministic per-day claim event + nonce read-back gates the spend: only the
//      writer that wins the onConflictDoNothing claim runs the director. Sequential retry
//      (claim already exists) and concurrent redeliver (nonce mismatch) both skip.
//
// NEVER calls reconcile (settlement single-home stays with the deterministic lane).

import type { Job } from 'pg-boss';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';

import {
  type DirectorDeps,
  RESEARCH_MEETING_AGENT_ACTOR,
  type ResearchMeetingDirectorResult,
  runResearchMeetingDirector,
  shanghaiDateKey,
} from '@/capabilities/agency/server/meeting/director';

/** Opt-in dark-ship flag. Handler early-returns unless this is exactly '1'. */
export const RESEARCH_MEETING_AGENT_ENABLED_ENV = 'RESEARCH_MEETING_AGENT_ENABLED';
/** action for the deterministic per-day claim event (generic ExperimentalEvent hatch). */
export const CLAIM_ACTION = 'experimental:research_meeting_agent_claim';

type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;
/** Reads back a claim event's payload (nonce compare). Null when the id does not exist. */
type ReadEventByIdFn = (db: Db, id: string) => Promise<{ payload: unknown } | null>;
type RunDirectorFn = (db: Db, deps: DirectorDeps) => Promise<ResearchMeetingDirectorResult>;

export interface AgentNightlyDeps extends DirectorDeps {
  /** injectable director run (unit tests stub this; db tests let it run for real). */
  runDirectorFn?: RunDirectorFn;
  /** injectable claim read-back (default reads the event table). */
  readEventByIdFn?: ReadEventByIdFn;
}

export interface AgentNightlyResult {
  skipped: boolean;
  reason?: string;
  day_key: string;
  director?: ResearchMeetingDirectorResult;
}

async function defaultReadEventById(db: Db, id: string): Promise<{ payload: unknown } | null> {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomically claim the day. Returns true only for the single writer whose claim persists
 * (first-write-wins via writeEvent's onConflictDoNothing). Covers BOTH the sequential
 * retry window (the claim already exists → the prior run won → skip) and the concurrent
 * redeliver window (both insert, only one nonce persists → the loser's read-back mismatches).
 */
async function claimDay(
  db: Db,
  opts: {
    dayKey: string;
    now: Date;
    writeEventFn: WriteEventFn;
    readEventByIdFn: ReadEventByIdFn;
  },
): Promise<boolean> {
  const claimEventId = `research_meeting_agent_claim:${opts.dayKey}`;
  const existing = await opts.readEventByIdFn(db, claimEventId);
  if (existing) return false; // a prior run already won today's claim (retry path)

  const claimNonce = newId();
  await opts.writeEventFn(db, {
    id: claimEventId,
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
    action: CLAIM_ACTION,
    subject_kind: 'query',
    subject_id: claimEventId,
    outcome: null,
    payload: { claim_nonce: claimNonce, day_key: opts.dayKey },
    cost_micro_usd: null,
    created_at: opts.now,
  });

  const persisted = await opts.readEventByIdFn(db, claimEventId);
  const persistedNonce = (persisted?.payload as { claim_nonce?: string } | undefined)?.claim_nonce;
  return persistedNonce === claimNonce;
}

/**
 * Run the agent lane for one night: claim the day, then (only if the claim is won) run
 * the director. The spend is STRICTLY gated behind winning the claim.
 */
export async function runResearchMeetingAgentNightly(
  db: Db,
  deps: AgentNightlyDeps = {},
): Promise<AgentNightlyResult> {
  const now = deps.now?.() ?? new Date();
  const dayKey = shanghaiDateKey(now);
  const writeEventFn = deps.writeEventFn ?? writeEvent;
  const readEventByIdFn = deps.readEventByIdFn ?? defaultReadEventById;
  const runDirectorFn = deps.runDirectorFn ?? runResearchMeetingDirector;

  const won = await claimDay(db, { dayKey, now, writeEventFn, readEventByIdFn });
  if (!won) {
    return { skipped: true, reason: 'already_claimed_today', day_key: dayKey };
  }

  // Pin `now` so the director shares the claim's timestamp (deterministic dayKey/events).
  const director = await runDirectorFn(db, { ...deps, now: () => now });
  return { skipped: false, day_key: dayKey, director };
}

export function buildResearchMeetingAgentNightlyHandler(
  db: Db,
  deps: AgentNightlyDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    // Dark-ship gate: default OFF. cron stays registered (the job exists); the handler
    // early-returns. Zero spend / zero events / zero proposals.
    if (process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV] !== '1') {
      console.log(
        `[research_meeting_agent_nightly] disabled (${RESEARCH_MEETING_AGENT_ENABLED_ENV} != 1)`,
      );
      return;
    }
    try {
      const result = await runResearchMeetingAgentNightly(db, deps);
      console.log('[research_meeting_agent_nightly] result', result);
    } catch (err) {
      console.error('[research_meeting_agent_nightly] failed', err);
      throw err; // pg-boss retry (idempotency guarded by the dayKey claim above)
    }
  };
}
