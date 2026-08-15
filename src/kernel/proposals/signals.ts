import { newId } from '@/core/ids';
import type { SuggestionKindT } from '@/core/schema/event/known';
import type { Db, Tx } from '@/db/client';
import { event, proposal_signals } from '@/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

export const PROPOSAL_DISMISS_COOLDOWN_DAYS = 7;

// YUK-76 codex P1 — serialize concurrent writers on `(kind, cooldown_key)`.
//
// `pg_advisory_xact_lock` releases at txn commit. When the caller passes a
// plain `Db` handle, each `db.execute(...)` runs in its own autocommit txn,
// so the lock would release between statements. We must open one explicit
// txn around lock-acquire + body so both rebuild and incremental writers
// hold the same lock across their full work.
//
// Both `ensureProposalDecisionSignal` (absolute rebuild) and
// `recordProposalDecisionSignal` (additive upsert) take the same lock key
// derived from `(kind, cooldown_key)`. Otherwise a rebuild based on a
// stale snapshot could land *after* a fresh incremental write and
// clobber it, walking `accept_count`/`dismiss_count` backwards.
async function withProposalSignalLock<T>(
  db: DbLike,
  kind: string,
  cooldownKey: string,
  fn: (tx: DbLike) => Promise<T>,
): Promise<T> {
  const lockKey = `${kind}:${cooldownKey}`;
  const acquireLock = (handle: DbLike) =>
    handle.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

  // Detect Tx vs Db. `Tx` strips `$client`; `Db` exposes it. We use that as
  // the discriminator to avoid nested-tx pitfalls when callers already opened
  // one (callers in `actions.ts` sometimes pass `tx` directly).
  if (!('$client' in db)) {
    // Already inside a txn — acquire lock + run body in-place.
    await acquireLock(db);
    return await fn(db);
  }
  return await (db as Db).transaction(async (tx) => {
    await acquireLock(tx);
    return await fn(tx);
  });
}

export interface ProposalSignalSnapshot {
  acceptance_rate: number;
  dismiss_reason: string | null;
  cooldown_until: Date | null;
  accept_count: number;
  dismiss_count: number;
}

export interface ProposalSignalSource {
  id: string;
  kind: string;
  payload: {
    cooldown_key?: string;
    // P5.6 / YUK-178 (call-site 5) — carry the corrective discriminator off the
    // proposal payload so the KPI gate can read it. The narrowed pick used to be
    // just { cooldown_key? } and would drop this field; absence === 'proactive'
    // (ND-SK-1). Corrective decisions are excluded from accept_count/dismiss_count
    // (SK-2 / §5.1).
    suggestion_kind?: SuggestionKindT;
  };
}

function signalKey(kind: string, cooldownKey: string): string {
  return `${kind}\u0000${cooldownKey}`;
}

function toSnapshot(row: typeof proposal_signals.$inferSelect): ProposalSignalSnapshot {
  return {
    acceptance_rate: row.acceptance_rate,
    dismiss_reason: row.dismiss_reason,
    cooldown_until: row.cooldown_until,
    accept_count: row.accept_count,
    dismiss_count: row.dismiss_count,
  };
}

function dismissCooldownUntil(now: Date): Date {
  return new Date(now.getTime() + PROPOSAL_DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
}

function dismissCooldownUntilFromRate(rate: EventRow): Date {
  return new Date(rate.created_at.getTime() + PROPOSAL_DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
}

export async function loadProposalSignalsForRows(
  db: DbLike,
  rows: ProposalSignalSource[],
): Promise<Map<string, ProposalSignalSnapshot>> {
  const cooldownKeys = [
    ...new Set(rows.map((row) => row.payload.cooldown_key).filter((key): key is string => !!key)),
  ];
  if (cooldownKeys.length === 0) return new Map();

  const signalRows = await db
    .select()
    .from(proposal_signals)
    .where(inArray(proposal_signals.cooldown_key, cooldownKeys));
  const signalByKey = new Map(
    signalRows.map((row) => [signalKey(row.kind, row.cooldown_key), toSnapshot(row)]),
  );

  const out = new Map<string, ProposalSignalSnapshot>();
  for (const row of rows) {
    const cooldownKey = row.payload.cooldown_key;
    if (!cooldownKey) continue;
    const signal = signalByKey.get(signalKey(row.kind, cooldownKey));
    if (signal) out.set(row.id, signal);
  }
  return out;
}

// T-AR (YUK-TAR) — acceptance-rate SIGNAL roll-up (read-only).
//
// The per-(kind, cooldown_key) `proposal_signals` aggregate already carries
// accept/dismiss counts (maintained by recordProposalDecisionSignal / rebuilt
// by ensureProposalDecisionSignal). This rolls those rows UP to the per-`kind`
// dimension that Dreaming / Coach actually reason about, so we never re-scan the
// unbounded event log (mastery-view precedent: derive from the existing aggregate,
// no new column / table / view). Used by the additive Dreaming feed; generic so
// Coach can reuse it later (see lane plan §DEFERRED).
export interface ProposalKindAcceptanceRate {
  kind: string;
  accept_count: number;
  dismiss_count: number;
  total: number;
  acceptance_rate: number;
}

/**
 * Aggregate proposal decision signals by proposal KIND.
 *
 * Cold start (no `proposal_signals` rows, or only zero-count rows) → `[]`. We do
 * NOT inject a uniform 0.5 sentinel: an empty list is the honest cold-start
 * signal and keeps the additive Dreaming feed a true no-op. Kinds whose summed
 * total is 0 are filtered out (also the div-by-zero guard). Sorted by
 * acceptance_rate DESC, total DESC so callers can take "top N proven kinds".
 */
export async function getProposalAcceptanceRates(
  db: DbLike,
): Promise<ProposalKindAcceptanceRate[]> {
  const rows = await db
    .select({
      kind: proposal_signals.kind,
      accept_count: sql<number>`SUM(${proposal_signals.accept_count})::int`,
      dismiss_count: sql<number>`SUM(${proposal_signals.dismiss_count})::int`,
    })
    .from(proposal_signals)
    .groupBy(proposal_signals.kind);

  return rows
    .map((row) => {
      const acceptCount = Number(row.accept_count ?? 0);
      const dismissCount = Number(row.dismiss_count ?? 0);
      const total = acceptCount + dismissCount;
      return {
        kind: row.kind,
        accept_count: acceptCount,
        dismiss_count: dismissCount,
        total,
        // total === 0 is filtered below, so this division never hits 0/0.
        acceptance_rate: total === 0 ? 0 : acceptCount / total,
      };
    })
    .filter((row) => row.total > 0)
    .sort((a, b) => b.acceptance_rate - a.acceptance_rate || b.total - a.total);
}

export async function recordProposalDecisionSignal(
  db: DbLike,
  proposal: ProposalSignalSource,
  decision: 'accept' | 'dismiss',
  dismissReason?: string,
): Promise<void> {
  const cooldownKey = proposal.payload.cooldown_key;
  if (!cooldownKey) return;

  // P5.6 / YUK-178 (SK-2 / LD-1 — full exclusion, incremental gate). A corrective
  // decision is recorded as an event upstream (actions.ts writes the `rate`
  // event), but it must NOT feed the P5.4-L2 accept-learned signal on EITHER side
  // (ND-SK-4): an accept-family decision skips `accept_count`, a dismiss skips
  // `dismiss_count`. Excluding only accepts would let a dismissed corrective
  // depress the cell rate denominator and tighten the L1 gate — re-introducing the
  // pollution LD-1 removes (§12 PIN 6 / re-critique issue 4). The gate skips the
  // KPI *count accounting*, NOT the cooldown write: a corrective dismiss still
  // persists its `cooldown_until` so the proposal is not re-surfaced.
  const isCorrective = proposal.payload.suggestion_kind === 'corrective';
  if (isCorrective && decision === 'accept') {
    // Accept-family: nothing to write — no row, no count, no cooldown clear.
    return;
  }

  // YUK-76 codex P1 — serialize with `ensureProposalDecisionSignal` rebuilds
  // on the same `(kind, cooldown_key)` so rebuild snapshots can't clobber a
  // freshly-recorded increment.
  await withProposalSignalLock(db, proposal.kind, cooldownKey, async (tx) => {
    await recordProposalDecisionSignalLocked(
      tx,
      proposal,
      cooldownKey,
      decision,
      dismissReason,
      // P5.6 — a corrective dismiss writes its cooldown but contributes 0 to
      // `dismiss_count` (count-suppressing flag, §12 PIN 6).
      !isCorrective,
    );
  });
}

async function recordProposalDecisionSignalLocked(
  db: DbLike,
  proposal: ProposalSignalSource,
  cooldownKey: string,
  decision: 'accept' | 'dismiss',
  dismissReason?: string,
  // P5.6 / YUK-178 — when false (corrective decision), zero the count delta so the
  // UPSERT bumps neither accept_count nor dismiss_count; the cooldown_until write
  // (dismiss path) still happens (ND-SK-4 / §12 PIN 6).
  countsTowardKpi = true,
): Promise<void> {
  const now = new Date();
  const acceptDelta = countsTowardKpi && decision === 'accept' ? 1 : 0;
  const dismissDelta = countsTowardKpi && decision === 'dismiss' ? 1 : 0;
  // P5.6 / YUK-178 — when this is a corrective dismiss creating a fresh row, both
  // deltas are 0 (the count is suppressed) so guard the initial rate against 0/0:
  // an all-zero-count row is rate 0 (matches getProposalAcceptanceRates' total===0
  // filter). The pre-P5.6 paths always had exactly one delta = 1, so this only
  // changes the corrective-dismiss-cold-start case.
  const totalDelta = acceptDelta + dismissDelta;
  const initialAcceptanceRate = totalDelta === 0 ? 0 : acceptDelta / totalDelta;
  const nowIso = now.toISOString();

  if (decision === 'accept') {
    await db.execute(sql`
      INSERT INTO proposal_signals (
        id,
        kind,
        cooldown_key,
        accept_count,
        dismiss_count,
        acceptance_rate,
        dismiss_reason,
        cooldown_until,
        created_at,
        updated_at
      )
      VALUES (
        ${newId()},
        ${proposal.kind},
        ${cooldownKey},
        ${acceptDelta},
        ${dismissDelta},
        ${initialAcceptanceRate},
        NULL,
        NULL,
        ${nowIso}::timestamptz,
        ${nowIso}::timestamptz
      )
      ON CONFLICT (kind, cooldown_key) DO UPDATE SET
        accept_count = proposal_signals.accept_count + ${acceptDelta},
        dismiss_count = proposal_signals.dismiss_count + ${dismissDelta},
        acceptance_rate =
          (proposal_signals.accept_count + ${acceptDelta})::real
          / NULLIF(
            proposal_signals.accept_count + proposal_signals.dismiss_count + ${acceptDelta} + ${dismissDelta},
            0
          ),
        dismiss_reason = proposal_signals.dismiss_reason,
        cooldown_until = NULL,
        updated_at = ${nowIso}::timestamptz
    `);
    return;
  }

  const nextCooldownUntilIso = dismissCooldownUntil(now).toISOString();
  const nextDismissReason = dismissReason ?? null;
  await db.execute(sql`
    INSERT INTO proposal_signals (
      id,
      kind,
      cooldown_key,
      accept_count,
      dismiss_count,
      acceptance_rate,
      dismiss_reason,
      cooldown_until,
      created_at,
      updated_at
    )
    VALUES (
      ${newId()},
      ${proposal.kind},
      ${cooldownKey},
      ${acceptDelta},
      ${dismissDelta},
      ${initialAcceptanceRate},
      ${nextDismissReason},
      ${nextCooldownUntilIso}::timestamptz,
      ${nowIso}::timestamptz,
      ${nowIso}::timestamptz
    )
    ON CONFLICT (kind, cooldown_key) DO UPDATE SET
      accept_count = proposal_signals.accept_count + ${acceptDelta},
      dismiss_count = proposal_signals.dismiss_count + ${dismissDelta},
      -- P5.6 / YUK-178 — COALESCE guards the 0/0 recompute. A corrective dismiss
      -- bumps neither count (countsTowardKpi=false), so an existing all-zero-count
      -- row (e.g. a prior corrective dismiss) would otherwise divide by NULLIF(0,0)
      -- = NULL and violate the NOT NULL acceptance_rate column. Treat 0/0 as rate 0.
      acceptance_rate = COALESCE(
        (proposal_signals.accept_count + ${acceptDelta})::real
        / NULLIF(
          proposal_signals.accept_count + proposal_signals.dismiss_count + ${acceptDelta} + ${dismissDelta},
          0
        ),
        0
      ),
      dismiss_reason = ${nextDismissReason},
      cooldown_until = ${nextCooldownUntilIso}::timestamptz,
      updated_at = ${nowIso}::timestamptz
  `);
}

type ProposalSignalDecision = 'accept' | 'dismiss';

function decisionFromRate(row: EventRow): ProposalSignalDecision | null {
  const rating = (row.payload as { rating?: unknown }).rating;
  if (rating === 'accept' || rating === 'reverse' || rating === 'change_type') return 'accept';
  if (rating === 'dismiss') return 'dismiss';
  return null;
}

function newerRate(a: EventRow | null, b: EventRow): EventRow {
  if (!a) return b;
  return b.created_at > a.created_at ||
    (b.created_at.getTime() === a.created_at.getTime() && b.id > a.id)
    ? b
    : a;
}

async function rebuildProposalDecisionSignal(
  db: DbLike,
  proposal: ProposalSignalSource,
  dismissReason?: string,
): Promise<void> {
  const cooldownKey = proposal.payload.cooldown_key;
  if (!cooldownKey) return;
  // P5.6 / YUK-178 (call-site 7) — also pull each sibling proposal's
  // `suggestion_kind` off its `ai_proposal` payload so the rebuild can reproduce
  // the same full KPI exclusion the incremental gate applies (SK-2 / §5.1 / AC-3b).
  // One `(kind, cooldown_key)` can aggregate MULTIPLE sibling proposals; the
  // corrective marker lives on the proposal payload, not the rate event, so we
  // build a Set of corrective proposal ids and skip BOTH accept and dismiss
  // counting for any rate row whose caused_by_event_id is in it.
  const proposalRows = await db
    .select({
      id: event.id,
      suggestion_kind: sql<string | null>`${event.payload}->'ai_proposal'->>'suggestion_kind'`,
    })
    .from(event)
    .where(
      and(
        sql`${event.payload}->'ai_proposal'->>'kind' = ${proposal.kind}`,
        sql`${event.payload}->'ai_proposal'->>'cooldown_key' = ${cooldownKey}`,
      ),
    );
  const proposalIds = [...new Set([...proposalRows.map((row) => row.id), proposal.id])];
  const correctiveProposalIds = new Set<string>(
    proposalRows.filter((row) => row.suggestion_kind === 'corrective').map((row) => row.id),
  );
  // The triggering proposal may not be in the `event.payload` scan above (e.g. a
  // tx not yet visible to this read) — fold its own marker in from the source.
  if (proposal.payload.suggestion_kind === 'corrective') {
    correctiveProposalIds.add(proposal.id);
  }
  const rateRows =
    proposalIds.length === 0
      ? []
      : await db
          .select()
          .from(event)
          .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, proposalIds)))
          .orderBy(desc(event.created_at), desc(event.id));

  const latestRateByProposal = new Map<string, EventRow>();
  for (const row of rateRows) {
    const proposalId = row.caused_by_event_id;
    if (proposalId && !latestRateByProposal.has(proposalId)) {
      latestRateByProposal.set(proposalId, row);
    }
  }

  // YUK-76 codex round-3 P1-B + P1-C — `cooldown_until` must reflect the
  // **key-wide latest** decision, not just the existence of any prior dismiss.
  // Same `(kind, cooldown_key)` can carry a history like dismiss→accept (user
  // changed their mind / accepted a different proposal on the same key). The
  // cooldown should only apply when the most recent decision across all
  // proposals on that key is still `dismiss`. If a later accept/reverse/
  // change_type has landed, the cooldown is cleared.
  //
  // Tie-break on equal created_at uses `newerRate`'s `id`-desc fallback so
  // two simultaneous rates resolve deterministically.
  let acceptCount = 0;
  let dismissCount = 0;
  let keyLatestRate: EventRow | null = null;
  for (const row of latestRateByProposal.values()) {
    const decision = decisionFromRate(row);
    if (decision === null) continue;
    // P5.6 / YUK-178 (full exclusion on replay, mirrors the incremental gate).
    // A corrective proposal's decision contributes to NEITHER acceptCount nor
    // dismissCount (ND-SK-4) — so a reconcile reproduces the gated counts (AC-3b).
    const isCorrective =
      row.caused_by_event_id !== null && correctiveProposalIds.has(row.caused_by_event_id);
    if (!isCorrective) {
      if (decision === 'accept') {
        acceptCount += 1;
      } else {
        dismissCount += 1;
      }
    }
    // Cooldown parity with the incremental path: a corrective DISMISS still
    // persists `cooldown_until` (the gate skips counting, not the cooldown), so it
    // still participates in the key-wide latest-decision scan. A corrective ACCEPT
    // does NOT clear an existing dismiss cooldown (the incremental accept gate
    // early-returns without touching the row), so it is excluded from keyLatestRate.
    if (isCorrective && decision === 'accept') continue;
    keyLatestRate = newerRate(keyLatestRate, row);
  }
  const total = acceptCount + dismissCount;
  // P5.6 parity boundary: a key whose ONLY decisions are corrective (both counts
  // gated to 0) early-returns here WITHOUT writing cooldown_until. This is safe
  // because the incremental path always runs first in production and OWNS the
  // cooldown for a corrective dismiss (it persists cooldown_until on the dismiss
  // INSERT); the only rebuild caller (ensureProposalDecisionSignal / reconcile)
  // runs over that already-written row, which this return leaves untouched. A
  // from-scratch event-log replay onto an empty table is not a production flow
  // for a corrective-dismiss-only key; full replay-parity is tracked as a
  // follow-up (no live-bug). See spec §5.1 / §12 PIN 6.
  if (total === 0) return;

  const acceptanceRate = acceptCount / total;
  const latestIsDismiss = keyLatestRate !== null && decisionFromRate(keyLatestRate) === 'dismiss';
  const latestDismissPayload = (keyLatestRate?.payload ?? {}) as { user_note?: unknown };
  const nextDismissReason = latestIsDismiss
    ? typeof latestDismissPayload.user_note === 'string'
      ? latestDismissPayload.user_note
      : keyLatestRate?.caused_by_event_id === proposal.id
        ? (dismissReason ?? null)
        : null
    : null;
  const cooldownUntilIso =
    latestIsDismiss && keyLatestRate
      ? dismissCooldownUntilFromRate(keyLatestRate).toISOString()
      : null;
  const nowIso = new Date().toISOString();

  await db.execute(sql`
    INSERT INTO proposal_signals (
      id,
      kind,
      cooldown_key,
      accept_count,
      dismiss_count,
      acceptance_rate,
      dismiss_reason,
      cooldown_until,
      created_at,
      updated_at
    )
    VALUES (
      ${newId()},
      ${proposal.kind},
      ${cooldownKey},
      ${acceptCount},
      ${dismissCount},
      ${acceptanceRate},
      ${nextDismissReason},
      ${cooldownUntilIso}::timestamptz,
      ${nowIso}::timestamptz,
      ${nowIso}::timestamptz
    )
    ON CONFLICT (kind, cooldown_key) DO UPDATE SET
      accept_count = ${acceptCount},
      dismiss_count = ${dismissCount},
      acceptance_rate = ${acceptanceRate},
      dismiss_reason = ${nextDismissReason},
      cooldown_until = ${cooldownUntilIso}::timestamptz,
      updated_at = ${nowIso}::timestamptz
  `);
}

export async function ensureProposalDecisionSignal(
  db: DbLike,
  proposal: ProposalSignalSource,
  _decision: 'accept' | 'dismiss',
  dismissReason?: string,
): Promise<void> {
  const cooldownKey = proposal.payload.cooldown_key;
  if (!cooldownKey) return;
  // YUK-76 codex P1 — `pg_advisory_xact_lock` releases at txn boundary. If
  // we let the previous implementation run on a plain `Db` handle, the lock
  // and the rebuild upsert lived in two separate autocommit txns, so the
  // lock did not actually protect the rebuild. `withProposalSignalLock`
  // opens one explicit txn (when needed) so lock + rebuild commit together.
  await withProposalSignalLock(db, proposal.kind, cooldownKey, async (tx) => {
    await rebuildProposalDecisionSignal(tx, proposal, dismissReason);
  });
}
