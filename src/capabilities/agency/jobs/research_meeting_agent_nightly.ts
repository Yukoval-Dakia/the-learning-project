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
//      ORPHANED-CLAIM RECOVERY (§2 review fix, MAJOR): a claim can exist WITHOUT the run
//      ever completing — specifically when the director's PRE-LLM reads throw
//      (director.ts never even reaches the LLM call, let alone a scan-event write) and
//      pg-boss retries. Without recovery, that day's claim would be permanently "won" by
//      a run that never actually did anything, silently masking a real failure as
//      `skipped: true` for the rest of the night. Recovery: the director ALWAYS writes a
//      scan event on completion (success OR degraded — director.ts, its own try/catch
//      around that write is best-effort but still attempted). So when today's claim
//      exists, we ADDITIONALLY check whether a scan event for today also exists:
//        - claim exists + NO scan  → the prior attempt died before ever reaching the
//          director's own event writes (a genuine PRE-LLM segment failure — zero spend
//          so far) → this run is allowed to retry.
//        - claim exists + scan exists → the normal complete-prior-run case → still skips.
//      Interaction with director.ts's §3 post-LLM best-effort persistence: if the scan
//      event write ITSELF fails (after the LLM already ran), the SAME "claim + no scan"
//      signal fires on the next invocation — that retry DOES re-spend tokens once (an
//      accepted, logged trade-off; see director.ts's degrade comment), unlike the
//      PRE-LLM-throw case above, which is a true zero-spend retry.
//
// NEVER calls reconcile (settlement single-home stays with the deterministic lane).

import type { Job } from 'pg-boss';

import {
  type DirectorDeps,
  RESEARCH_MEETING_AGENT_ACTOR,
  type ResearchMeetingDirectorResult,
  SCAN_ACTION,
  runResearchMeetingDirector,
  shanghaiDateKey,
} from '@/capabilities/agency/server/meeting/director';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
import { and, eq, sql } from 'drizzle-orm';

/** Opt-in dark-ship flag. Handler early-returns unless this is exactly '1'. */
export const RESEARCH_MEETING_AGENT_ENABLED_ENV = 'RESEARCH_MEETING_AGENT_ENABLED';
/** action for the deterministic per-day claim event (generic ExperimentalEvent hatch). */
export const CLAIM_ACTION = 'experimental:research_meeting_agent_claim';

type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;
/** Reads back a claim event's payload (nonce compare). Null when the id does not exist. */
type ReadEventByIdFn = (db: Db, id: string) => Promise<{ payload: unknown } | null>;
/** §2 review fix: existence check for TODAY's scan event — distinguishes a completed
 *  prior run (claim + scan both exist → skip) from an orphaned claim (claim exists, no
 *  scan → a prior PRE-LLM segment failure; safe to retry). */
type HasScanEventForDayFn = (db: Db, dayKey: string) => Promise<boolean>;
type RunDirectorFn = (db: Db, deps: DirectorDeps) => Promise<ResearchMeetingDirectorResult>;

export interface AgentNightlyDeps extends DirectorDeps {
  /** injectable director run (unit tests stub this; db tests let it run for real). */
  runDirectorFn?: RunDirectorFn;
  /** injectable claim read-back (default reads the event table). */
  readEventByIdFn?: ReadEventByIdFn;
  /** injectable scan-existence check (default queries the event table). */
  hasScanEventForDayFn?: HasScanEventForDayFn;
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

/** §2 review fix default: queries whether a scan event for `dayKey` already landed.
 *  SCAN_ACTION events always carry `day_key` in their payload (director.ts). */
async function defaultHasScanEventForDay(db: Db, dayKey: string): Promise<boolean> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, SCAN_ACTION),
        eq(event.actor_ref, RESEARCH_MEETING_AGENT_ACTOR),
        sql`${event.payload}->>'day_key' = ${dayKey}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

interface ClaimResult {
  won: boolean;
}

/**
 * Atomically claim the day. Returns `won: true` only for the caller allowed to run the
 * director this invocation — either because it is the FIRST writer whose claim persists
 * (first-write-wins via writeEvent's onConflictDoNothing, covering the concurrent
 * redeliver window where both insert but only one nonce sticks), or because today's claim
 * already existed but is ORPHANED (no scan event yet — §2 review fix, a prior PRE-LLM
 * segment failure with zero spend so far, safe to retry). The normal sequential-retry
 * case (claim exists AND a scan event already landed) returns `won: false`.
 */
async function claimDay(
  db: Db,
  opts: {
    dayKey: string;
    now: Date;
    writeEventFn: WriteEventFn;
    readEventByIdFn: ReadEventByIdFn;
    hasScanEventForDayFn: HasScanEventForDayFn;
  },
): Promise<ClaimResult> {
  const claimEventId = `research_meeting_agent_claim:${opts.dayKey}`;
  const existing = await opts.readEventByIdFn(db, claimEventId);
  if (existing) {
    const scanExists = await opts.hasScanEventForDayFn(db, opts.dayKey);
    return { won: !scanExists };
  }

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
  return { won: persistedNonce === claimNonce };
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
  const hasScanEventForDayFn = deps.hasScanEventForDayFn ?? defaultHasScanEventForDay;
  const runDirectorFn = deps.runDirectorFn ?? runResearchMeetingDirector;

  const claim = await claimDay(db, {
    dayKey,
    now,
    writeEventFn,
    readEventByIdFn,
    hasScanEventForDayFn,
  });
  if (!claim.won) {
    return { skipped: true, reason: 'already_claimed_today', day_key: dayKey };
  }

  // §8 review fix — destructure OUT the job-only fields before forwarding to the
  // director: DirectorDeps has no use for them, and a blanket `...deps` spread would
  // silently leak job-internal plumbing (runDirectorFn / readEventByIdFn /
  // hasScanEventForDayFn) into the director's deps surface.
  const {
    runDirectorFn: _runDirectorFn,
    readEventByIdFn: _readEventByIdFn,
    hasScanEventForDayFn: _hasScanEventForDayFn,
    ...directorDeps
  } = deps;
  // Pin `now` so the director shares the claim's timestamp (deterministic dayKey/events).
  const director = await runDirectorFn(db, { ...directorDeps, now: () => now });
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
