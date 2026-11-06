// Verdict-rate breaker for the proposal auto-apply lane: windowed `rate` event
// counts mapped to ok/warned/tripped. Kernel-owned because the auto-apply
// executor and the shell digest both consult it, and kernel cannot import a
// capability.
//
// Counting only reads `event.action='rate'` (the event log is the SoT; no table).
// warn only informs, max is the hard stop: the executor applies nothing past it
// and leaves the proposals for human review.
//
// Red line: only counts rate velocity, never touches θ̂ / p(L) / FSRS.

import { and, eq, gte, lte, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

type DbLike = Db | Tx;

// 1h window; warn=12 / max=30 are multiples of a normal decision rate.
export const VERDICT_RATE_WINDOW_MS = 3_600_000;
export const VERDICT_AUTOAPPLY_WARN = 12;
export const VERDICT_AUTOAPPLY_MAX = 30;

export type VerdictBreakerStatus = 'ok' | 'warned' | 'tripped';

export interface CheckVerdictRateBreakerInput {
  /** Decisions already inside the window (before this one). */
  recentCount: number;
  /** warn level: at/above → 'warned'. Defaults to VERDICT_AUTOAPPLY_WARN. */
  warn?: number;
  /** max level: at/above → 'tripped'. Defaults to VERDICT_AUTOAPPLY_MAX. */
  max?: number;
}

/**
 * Pure decision (zero IO): < warn → ok; ≥ warn → warned; ≥ max → tripped.
 * max is checked before warn, so warn === max leaves one hard boundary.
 */
export function checkVerdictRateBreaker(input: CheckVerdictRateBreakerInput): {
  status: VerdictBreakerStatus;
} {
  const warn = input.warn ?? VERDICT_AUTOAPPLY_WARN;
  const max = input.max ?? VERDICT_AUTOAPPLY_MAX;
  const count = input.recentCount;
  if (count >= max) return { status: 'tripped' };
  if (count >= warn) return { status: 'warned' };
  return { status: 'ok' };
}

export interface CountRecentVerdictsInput {
  /** Window right edge (usually the auto-apply instant). */
  now: Date;
  /** Window length in ms. Defaults to VERDICT_RATE_WINDOW_MS. */
  windowMs?: number;
}

/**
 * Count `event.action='rate'` rows inside the window (one rate = one decision).
 * Count only; never reads θ̂ / p(L) / FSRS state.
 */
export async function countRecentVerdicts(
  db: DbLike,
  input: CountRecentVerdictsInput,
): Promise<number> {
  const windowMs = input.windowMs ?? VERDICT_RATE_WINDOW_MS;
  const windowStart = new Date(input.now.getTime() - windowMs);
  // Upper bound created_at <= now: future-dated rates do not inflate the meter.
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        gte(event.created_at, windowStart),
        lte(event.created_at, input.now),
      ),
    );
  return rows[0]?.value ?? 0;
}

/** Breaker snapshot consumed by the A-lane meter/banner. */
export interface VerdictBreakerResult {
  /** true → max reached. */
  tripped: boolean;
  /** Three-level status. */
  level: VerdictBreakerStatus;
  /** Decisions in the window (meter level). */
  applied: number;
  /** max level (meter full scale). */
  cap: number;
  /** Window length in ms. */
  window: number;
}

/** Read the window count and map it to the breaker snapshot; counter injectable for tests. */
export async function checkAutoApplyBreaker(
  db: DbLike,
  now: Date,
  deps: { countRecentVerdicts?: (input: CountRecentVerdictsInput) => Promise<number> } = {},
): Promise<VerdictBreakerResult> {
  const count = deps.countRecentVerdicts
    ? await deps.countRecentVerdicts({ now })
    : await countRecentVerdicts(db, { now });
  const { status } = checkVerdictRateBreaker({ recentCount: count });
  return {
    tripped: status === 'tripped',
    level: status,
    applied: count,
    cap: VERDICT_AUTOAPPLY_MAX,
    window: VERDICT_RATE_WINDOW_MS,
  };
}
