// Nightly supply spend gate: the one place that decides whether nightly supply work may
// spend and what each unit of it is charged. Callers: the nightly dispatch (hold before
// enqueue), the in-demand route fallback (hold before the send), and the web sourcing run
// (grow the hold into its run cap, then settle). Work the nightly did not admit is not gated.
//
// Ledger: append-only `experimental:supply_spend` events, subject = learner day
// (Asia/Shanghai, core/learner-day). A key's records stay on the day of its first hold.
// Day total = Σ per key (settled ? charge : hold), kept ≤ SUPPLY_NIGHTLY_SPEND_CAP_USD under
// that day's advisory lock. A run's actual cost is its ai_task_runs cost truth; a started run
// without a priced cost is charged its hold, never zero. Verification (source_verify /
// quiz_verify) and generation jobs run outside supply and cannot be attributed to a unit, so
// they are charged at their reservation.
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getConfig } from '@/core/config/store';
import { learnerLocalDay } from '@/core/learner-day';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { lockSupplySpendDay } from '@/kernel/locks/question-supply';

const SUPPLY_SPEND_ACTION = 'experimental:supply_spend';
const CAP_CONFIG_KEY = 'SUPPLY_NIGHTLY_SPEND_CAP_USD';

/** Hold for one sourcing or generation run before it starts. A sourcing run grows it into
 * its own cap from free budget when it starts and settles to its actual cost. */
const RUN_RESERVATION_MICRO_USD = 100_000;
/** Per-question verification charge; also what a requested question holds until settlement. */
const VERIFY_RESERVATION_MICRO_USD = 10_000;

const SpendRecord = z.object({
  version: z.literal(1),
  day: z.string(),
  key: z.string(),
  seq: z.number().int().nonnegative(),
  kind: z.enum(['hold', 'settle']),
  hold_micro_usd: z.number().int().nonnegative(),
  /** Part of the hold kept for verification of the unit's questions. */
  verify_micro_usd: z.number().int().nonnegative(),
  charge_micro_usd: z.number().int().nonnegative().optional(),
  basis: z.enum(['actual', 'hold', 'released']).optional(),
  task_run_ids: z.array(z.string()).optional(),
});
type SpendRecordT = z.infer<typeof SpendRecord>;

const nightlyUnitKey = (targetId: string) => `nightly:${targetId}`;
const fallbackKey = (targetId: string, route: string) => `nightly:${targetId}:fallback:${route}`;

function capMicroUsd(): number {
  const value = getConfig(CAP_CONFIG_KEY);
  // An unreadable cap admits nothing rather than everything.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000)
    : 0;
}

function chargeOf(record: SpendRecordT): number {
  return record.kind === 'settle' ? (record.charge_micro_usd ?? 0) : record.hold_micro_usd;
}

/** Latest record per key on one day. */
async function readDay(db: Db | Tx, day: string): Promise<Map<string, SpendRecordT>> {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'query'),
        eq(event.subject_id, day),
        eq(event.action, SUPPLY_SPEND_ACTION),
      ),
    );
  const latest = new Map<string, SpendRecordT>();
  for (const row of rows) {
    const parsed = SpendRecord.safeParse(row.payload);
    // A record this gate cannot read could be a live hold: refuse to guess the day total.
    if (!parsed.success) throw new Error(`unreadable supply spend record on ${day}`);
    const prior = latest.get(parsed.data.key);
    if (!prior || parsed.data.seq > prior.seq) latest.set(parsed.data.key, parsed.data);
  }
  return latest;
}

function dayTotal(records: Map<string, SpendRecordT>): number {
  let total = 0;
  for (const record of records.values()) total += chargeOf(record);
  return total;
}

async function dayOfKey(db: Db, key: string): Promise<string | null> {
  const [row] = await db
    .select({ day: event.subject_id })
    .from(event)
    .where(and(eq(event.action, SUPPLY_SPEND_ACTION), sql`${event.payload}->>'key' = ${key}`))
    .limit(1);
  return row?.day ?? null;
}

async function onDay<T>(
  db: Db,
  day: string,
  work: (tx: Tx, records: Map<string, SpendRecordT>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockSupplySpendDay(tx, day);
    return work(tx, await readDay(tx, day));
  });
}

async function append(tx: Tx, record: SpendRecordT): Promise<void> {
  const now = new Date();
  await writeEvent(tx, {
    id: `supply_spend_${createHash('sha256').update(record.key).digest('hex')}_${record.seq}`,
    action: SUPPLY_SPEND_ACTION,
    subject_kind: 'query',
    subject_id: record.day,
    actor_kind: 'agent',
    actor_ref: 'supply_spend_gate',
    outcome: 'success',
    payload: SpendRecord.parse(record),
    caused_by_event_id: null,
    task_run_id: null,
    // Holds are not spend; keep them out of every event-cost sum.
    cost_micro_usd: null,
    created_at: now,
    session_id: null,
    ingest_at: now,
  });
}

export type SupplySpendHold =
  | { granted: true }
  | { granted: false; capMicroUsd: number; committedMicroUsd: number };

async function holdNewKey(
  db: Db,
  input: { key: string; holdMicroUsd: number; verifyMicroUsd: number; now: Date },
): Promise<SupplySpendHold> {
  const day = learnerLocalDay(input.now);
  const cap = capMicroUsd();
  return onDay(db, day, async (tx, records) => {
    if (records.has(input.key)) return { granted: true };
    const committed = dayTotal(records);
    if (committed + input.holdMicroUsd > cap) {
      return { granted: false, capMicroUsd: cap, committedMicroUsd: committed };
    }
    await append(tx, {
      version: 1,
      day,
      key: input.key,
      seq: 0,
      kind: 'hold',
      hold_micro_usd: input.holdMicroUsd,
      verify_micro_usd: input.verifyMicroUsd,
    });
    return { granted: true };
  });
}

/** Nightly dispatch: hold one unit (a run plus verification of each requested question)
 * before the target is enqueued. A denied target is left for the next night. */
export function holdNightlySupplyUnit(
  db: Db,
  input: { targetId: string; questionCount: number; now?: Date },
): Promise<SupplySpendHold> {
  const verify = input.questionCount * VERIFY_RESERVATION_MICRO_USD;
  return holdNewKey(db, {
    key: nightlyUnitKey(input.targetId),
    holdMicroUsd: RUN_RESERVATION_MICRO_USD + verify,
    verifyMicroUsd: verify,
    now: input.now ?? new Date(),
  });
}

/** A held target that was not actually enqueued spent nothing. */
export async function releaseNightlySupplyUnit(db: Db, targetId: string): Promise<void> {
  const key = nightlyUnitKey(targetId);
  const day = await dayOfKey(db, key);
  if (!day) return;
  await onDay(db, day, async (tx, records) => {
    const current = records.get(key);
    if (!current || current.kind === 'settle') return;
    await append(tx, {
      ...current,
      seq: current.seq + 1,
      kind: 'settle',
      charge_micro_usd: 0,
      basis: 'released',
    });
  });
}

/**
 * In-demand route switch of a nightly unit: hold the next route's work (a generation run for
 * quiz_gen, verification of each question for every route) before its send. `denied` leaves
 * the fallback pending for a later sweep on a later night; work the nightly never admitted is
 * `not_nightly` and goes ahead ungated.
 */
export async function holdNightlyRouteFallback(
  db: Db,
  input: { targetId: string; route: string; questionCount: number; now?: Date },
): Promise<'not_nightly' | 'granted' | 'denied'> {
  const key = fallbackKey(input.targetId, input.route);
  if (await dayOfKey(db, key)) return 'granted';
  if (!(await dayOfKey(db, nightlyUnitKey(input.targetId)))) return 'not_nightly';
  const verify = input.questionCount * VERIFY_RESERVATION_MICRO_USD;
  const hold = await holdNewKey(db, {
    key,
    holdMicroUsd: (input.route === 'quiz_gen' ? RUN_RESERVATION_MICRO_USD : 0) + verify,
    verifyMicroUsd: verify,
    now: input.now ?? new Date(),
  });
  return hold.granted ? 'granted' : 'denied';
}

export type NightlySourcingAdmission = { gated: false } | { gated: true; runCapMicroUsd: number };

/**
 * Right before a nightly unit's paid sourcing call: grow its hold toward `runCeilingMicroUsd`
 * (the lower of the gap's declared budget and the task cap) with whatever the day has free,
 * and return what the run may spend. A unit that already settled may not run again (0).
 */
export async function admitNightlySourcingRun(
  db: Db,
  input: { targetId: string; runCeilingMicroUsd: number },
): Promise<NightlySourcingAdmission> {
  const key = nightlyUnitKey(input.targetId);
  const day = await dayOfKey(db, key);
  if (!day) return { gated: false };
  const cap = capMicroUsd();
  return onDay(db, day, async (tx, records) => {
    const current = records.get(key);
    if (!current || current.kind === 'settle') return { gated: true, runCapMicroUsd: 0 };
    const free = Math.max(0, cap - dayTotal(records));
    const wanted = input.runCeilingMicroUsd + current.verify_micro_usd;
    const hold = Math.max(current.hold_micro_usd, Math.min(wanted, current.hold_micro_usd + free));
    if (hold > current.hold_micro_usd) {
      await append(tx, { ...current, seq: current.seq + 1, hold_micro_usd: hold });
    }
    return {
      gated: true,
      runCapMicroUsd: Math.min(input.runCeilingMicroUsd, hold - current.verify_micro_usd),
    };
  });
}

/** USD cost truth of runs; a run with no row never reached the provider. */
async function runCostMicroUsd(
  db: Db,
  taskRunIds: readonly string[],
): Promise<{ known: number; unpriced: boolean }> {
  if (taskRunIds.length === 0) return { known: 0, unpriced: false };
  const rows = await db
    .select({ costUsd: ai_task_runs.cost_usd, basis: ai_task_runs.cost_basis })
    .from(ai_task_runs)
    .where(inArray(ai_task_runs.id, [...new Set(taskRunIds)]));
  let known = 0;
  let unpriced = false;
  for (const row of rows) {
    if ((row.basis === 'reported' || row.basis === 'estimated') && row.costUsd !== null) {
      known += Math.round(row.costUsd * 1_000_000);
    } else {
      unpriced = true;
    }
  }
  return { known, unpriced };
}

/**
 * After a nightly unit's sourcing call returned or failed: charge the run's actual cost (its
 * hold when the cost is unknown), plus verification of the questions it submitted. The
 * difference to the hold goes back to, or comes out of, the day's budget.
 */
export async function settleNightlySourcingRun(
  db: Db,
  input: { targetId: string; taskRunIds: readonly string[]; submittedCount: number },
): Promise<void> {
  const key = nightlyUnitKey(input.targetId);
  const day = await dayOfKey(db, key);
  if (!day) return;
  const cost = await runCostMicroUsd(db, input.taskRunIds);
  await onDay(db, day, async (tx, records) => {
    const current = records.get(key);
    if (!current || current.kind === 'settle') return;
    const runCharge = cost.unpriced
      ? current.hold_micro_usd - current.verify_micro_usd
      : cost.known;
    await append(tx, {
      ...current,
      seq: current.seq + 1,
      kind: 'settle',
      charge_micro_usd: runCharge + input.submittedCount * VERIFY_RESERVATION_MICRO_USD,
      basis: cost.unpriced ? 'hold' : 'actual',
      task_run_ids: [...input.taskRunIds],
    });
  });
}
