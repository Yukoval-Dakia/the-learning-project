// YUK-572 PR-2 §3 — agent-led 教研例会 nightly job (shadow lane, dark-ship).
//
// The pg-boss handler for the agent director lane. Structurally distinct from the
// deterministic research_meeting_nightly (which is the untouched control group): this
// runs the charter-agent director (runResearchMeetingDirector) behind two guards:
//
//   1. Kill switch RESEARCH_MEETING_AGENT_ENABLED — default OFF (dark-ship). The cron is
//      registered (the job exists) but the handler early-returns unless the shared
//      runtime-flag grammar enables it:
//      zero spend, zero events, zero proposals. Flip = set the worker container .env +
//      restart (single-process, one env — no AI-provider three-process wiring here).
//
//   2. dayKey nonce-claim idempotency — a deterministic per-day claim event + nonce
//      read-back gates the initial spend. Sequential/concurrent delivery skips unless
//      the controlled one-shot recovery protocol below proves the initial run ended.
//
//      CONTROLLED RECOVERY: claim + no scan is NOT sufficient by itself. Each initial
//      claim carries a lease longer than the director's own wall-clock budget. While
//      that lease is active, a delivery cannot spend; the production handler keeps a
//      redelivery alive until the lease boundary instead of acknowledging it early.
//      A caught retryable failure writes an explicit failure marker and makes the claim
//      immediately recoverable; an unmarked hard crash becomes recoverable only after
//      lease expiry. Recovery itself must win a SECOND fixed-id nonce claim and carries
//      recovery_attempt=1. That marker is never reused or updated, so only one recovery
//      can run and any concurrent/repeated redelivery skips. A scan still wins over
//      every recovery path.
//
// NEVER calls reconcile (settlement single-home stays with the deterministic lane).

import { writeEvent } from '@/kernel/events';
import type { Job } from 'pg-boss';

import {
  type DirectorDeps,
  RESEARCH_MEETING_AGENT_ACTOR,
  RESEARCH_MEETING_AGENT_WALL_CLOCK_S,
  type ResearchMeetingDirectorResult,
  SCAN_ACTION,
  runResearchMeetingDirector,
  shanghaiDateKey,
} from '@/capabilities/agency/server/meeting/director';
import { parseFlag } from '@/core/env-flags';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import type { WriteEventInput } from '@/kernel/events';
import { ConjectureInductionOperationalError } from '@/server/agency/conjecture/induce';
import { costUsdToMicroUsd } from '@/server/ai/provenance';
import { and, eq, sql } from 'drizzle-orm';

/** Opt-in dark-ship flag. Handler uses the shared runtime-flag grammar. */
export const RESEARCH_MEETING_AGENT_ENABLED_ENV = 'RESEARCH_MEETING_AGENT_ENABLED';
/** action for the deterministic per-day claim event (generic ExperimentalEvent hatch). */
export const CLAIM_ACTION = 'experimental:research_meeting_agent_claim';
/** Fixed-id second-tier claim: at most one recovery attempt per day. */
export const RECOVERY_CLAIM_ACTION = 'experimental:research_meeting_agent_recovery_claim';
/** A caught director failure proves the initial lease is no longer actively running. */
export const RETRYABLE_FAILURE_ACTION = 'experimental:research_meeting_agent_retryable_failure';
/** Director timeout plus one minute of orchestration/persistence grace. */
export const CLAIM_LEASE_MS = (RESEARCH_MEETING_AGENT_WALL_CLOCK_S + 60) * 1000;

type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;
/** Reads back a claim event's payload (nonce compare). Null when the id does not exist. */
type ReadEventByIdFn = (db: Db, id: string) => Promise<{ payload: unknown } | null>;
/** A scan is authoritative completion. Its absence only opens the lease/failure-marker
 *  checks; it never grants recovery by itself. */
type HasScanEventForDayFn = (db: Db, dayKey: string) => Promise<boolean>;
type RunDirectorFn = (db: Db, deps: DirectorDeps) => Promise<ResearchMeetingDirectorResult>;
type WaitUntilFn = (retryAt: Date) => Promise<void>;

export interface AgentNightlyDeps extends DirectorDeps {
  /** injectable director run (unit tests stub this; db tests let it run for real). */
  runDirectorFn?: RunDirectorFn;
  /** injectable claim read-back (default reads the event table). */
  readEventByIdFn?: ReadEventByIdFn;
  /** injectable scan-existence check (default queries the event table). */
  hasScanEventForDayFn?: HasScanEventForDayFn;
  /** injectable lease-boundary wait (production uses a timer; unit tests advance a fake clock). */
  waitUntilFn?: WaitUntilFn;
}

export interface AgentNightlyResult {
  skipped: boolean;
  reason?: string;
  retry_at?: string;
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
  attemptKind?: 'initial' | 'recovery';
  activeLeaseUntil?: Date;
}

function recoveryClaimEventId(dayKey: string): string {
  return `research_meeting_agent_recovery:${dayKey}`;
}

function retryableFailureEventId(dayKey: string, attemptKind: 'initial' | 'recovery'): string {
  return `research_meeting_agent_retryable_failure:${dayKey}:${attemptKind}`;
}

function readLeaseExpiry(payload: unknown): Date | null {
  const leaseExpiresAt =
    typeof payload === 'object' && payload !== null && 'lease_expires_at' in payload
      ? (payload as { lease_expires_at?: unknown }).lease_expires_at
      : undefined;
  if (typeof leaseExpiresAt !== 'string') return null;
  const timestamp = Date.parse(leaseExpiresAt);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

async function defaultWaitUntil(retryAt: Date): Promise<void> {
  const waitMs = Math.max(0, retryAt.getTime() - Date.now());
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
}

/**
 * Atomically claim the day. Returns `won: true` only for the caller allowed to run the
 * director this invocation — either because it is the FIRST writer whose claim persists
 * (first-write-wins via writeEvent's onConflictDoNothing, covering the concurrent
 * redeliver window where both insert but only one nonce sticks), or because the initial
 * run is explicitly failed/lease-expired AND this caller wins the one fixed recovery
 * claim. Active leases, completed scans, and an existing recovery marker return false.
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
    if (scanExists) return { won: false };

    // A fixed recovery id is the recovery-attempt counter: once present, attempt #1
    // has already been claimed and there is no attempt #2.
    const recoveryEventId = recoveryClaimEventId(opts.dayKey);
    const recovery = await opts.readEventByIdFn(db, recoveryEventId);
    if (recovery) return { won: false };

    // Caught failures explicitly end the active lease. A hard crash cannot write that
    // marker, so it must wait for lease expiry. Legacy claims without lease metadata
    // fail closed (no recovery) rather than risking duplicate spend.
    const failure = await opts.readEventByIdFn(db, retryableFailureEventId(opts.dayKey, 'initial'));
    if (!failure) {
      const activeLeaseUntil = readLeaseExpiry(existing.payload);
      if (!activeLeaseUntil) {
        return { won: false };
      }
      if (opts.now.getTime() < activeLeaseUntil.getTime()) {
        return { won: false, activeLeaseUntil };
      }
    }

    const recoveryNonce = newId();
    await opts.writeEventFn(db, {
      id: recoveryEventId,
      actor_kind: 'agent',
      actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
      action: RECOVERY_CLAIM_ACTION,
      subject_kind: 'query',
      subject_id: recoveryEventId,
      outcome: null,
      payload: {
        claim_nonce: recoveryNonce,
        day_key: opts.dayKey,
        attempt_kind: 'recovery',
        recovery_attempt: 1,
        lease_expires_at: new Date(opts.now.getTime() + CLAIM_LEASE_MS).toISOString(),
      },
      cost_micro_usd: null,
      ingest_at: opts.now,
      created_at: opts.now,
    });
    const persistedRecovery = await opts.readEventByIdFn(db, recoveryEventId);
    const persistedRecoveryNonce = (
      persistedRecovery?.payload as { claim_nonce?: string } | undefined
    )?.claim_nonce;
    return {
      won: persistedRecoveryNonce === recoveryNonce,
      attemptKind: persistedRecoveryNonce === recoveryNonce ? 'recovery' : undefined,
    };
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
    payload: {
      claim_nonce: claimNonce,
      day_key: opts.dayKey,
      attempt_kind: 'initial',
      recovery_attempt: 0,
      lease_expires_at: new Date(opts.now.getTime() + CLAIM_LEASE_MS).toISOString(),
    },
    cost_micro_usd: null,
    // Scheduler claim/audit metadata is not learner evidence.
    ingest_at: opts.now,
    created_at: opts.now,
  });

  const persisted = await opts.readEventByIdFn(db, claimEventId);
  const persistedNonce = (persisted?.payload as { claim_nonce?: string } | undefined)?.claim_nonce;
  return {
    won: persistedNonce === claimNonce,
    attemptKind: persistedNonce === claimNonce ? 'initial' : undefined,
  };
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
    if (claim.activeLeaseUntil) {
      return {
        skipped: true,
        reason: 'active_lease',
        retry_at: claim.activeLeaseUntil.toISOString(),
        day_key: dayKey,
      };
    }
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
    waitUntilFn: _waitUntilFn,
    ...directorDeps
  } = deps;
  // Pin `now` so the director shares the claim's timestamp (deterministic dayKey/events).
  try {
    const director = await runDirectorFn(db, { ...directorDeps, now: () => now });
    return { skipped: false, day_key: dayKey, director };
  } catch (err) {
    const attemptKind = claim.attemptKind ?? 'initial';
    const inductionFailure = err instanceof ConjectureInductionOperationalError ? err : null;
    try {
      const failureId = retryableFailureEventId(dayKey, attemptKind);
      await writeEventFn(db, {
        id: failureId,
        actor_kind: 'agent',
        actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
        action: RETRYABLE_FAILURE_ACTION,
        subject_kind: 'query',
        subject_id: failureId,
        outcome: 'failure',
        payload: {
          day_key: dayKey,
          attempt_kind: attemptKind,
          recovery_attempt: attemptKind === 'recovery' ? 1 : 0,
          error: err instanceof Error ? err.message : String(err),
          ...(inductionFailure
            ? {
                task_kind: inductionFailure.taskKind,
                probe_quality_attempts: inductionFailure.probe_quality_attempts,
                task_run_ids: inductionFailure.task_run_ids,
                cost_usd: inductionFailure.cost_usd,
              }
            : {}),
        },
        task_run_id: inductionFailure?.task_run_ids.at(-1) ?? null,
        cost_micro_usd: inductionFailure ? costUsdToMicroUsd(inductionFailure.cost_usd) : null,
        ingest_at: now,
        created_at: now,
      });
    } catch (markerError) {
      console.error(
        '[research_meeting_agent_nightly] failed to persist retryable failure marker',
        markerError,
      );
    }
    throw err;
  }
}

export function buildResearchMeetingAgentNightlyHandler(
  db: Db,
  deps: AgentNightlyDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    // Dark-ship gate: default OFF. cron stays registered (the job exists); the handler
    // early-returns. Zero spend / zero events / zero proposals.
    if (!parseFlag(process.env[RESEARCH_MEETING_AGENT_ENABLED_ENV])) {
      console.log(
        `[research_meeting_agent_nightly] disabled (${RESEARCH_MEETING_AGENT_ENABLED_ENV})`,
      );
      return;
    }
    try {
      let result = await runResearchMeetingAgentNightly(db, deps);
      while (result.reason === 'active_lease' && result.retry_at) {
        // The queue's normal 30s/60s retry budget ends before the 360s claim lease.
        // A hard-crash redelivery must therefore remain active until the exact lease
        // boundary; acknowledging here would permanently lose the only recovery chance.
        const retryAt = new Date(result.retry_at);
        await (deps.waitUntilFn ?? defaultWaitUntil)(retryAt);
        result = await runResearchMeetingAgentNightly(db, deps);
      }
      console.log('[research_meeting_agent_nightly] result', result);
    } catch (err) {
      console.error('[research_meeting_agent_nightly] failed', err);
      throw err; // pg-boss retry (idempotency guarded by the dayKey claim above)
    }
  };
}
