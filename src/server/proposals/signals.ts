import { newId } from '@/core/ids';
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

export async function recordProposalDecisionSignal(
  db: DbLike,
  proposal: ProposalSignalSource,
  decision: 'accept' | 'dismiss',
  dismissReason?: string,
): Promise<void> {
  const cooldownKey = proposal.payload.cooldown_key;
  if (!cooldownKey) return;

  // YUK-76 codex P1 — serialize with `ensureProposalDecisionSignal` rebuilds
  // on the same `(kind, cooldown_key)` so rebuild snapshots can't clobber a
  // freshly-recorded increment.
  await withProposalSignalLock(db, proposal.kind, cooldownKey, async (tx) => {
    await recordProposalDecisionSignalLocked(tx, proposal, cooldownKey, decision, dismissReason);
  });
}

async function recordProposalDecisionSignalLocked(
  db: DbLike,
  proposal: ProposalSignalSource,
  cooldownKey: string,
  decision: 'accept' | 'dismiss',
  dismissReason?: string,
): Promise<void> {
  const now = new Date();
  const acceptDelta = decision === 'accept' ? 1 : 0;
  const dismissDelta = decision === 'dismiss' ? 1 : 0;
  const initialAcceptanceRate = acceptDelta / (acceptDelta + dismissDelta);
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
      acceptance_rate =
        (proposal_signals.accept_count + ${acceptDelta})::real
        / NULLIF(
          proposal_signals.accept_count + proposal_signals.dismiss_count + ${acceptDelta} + ${dismissDelta},
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
  const proposalRows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        sql`${event.payload}->'ai_proposal'->>'kind' = ${proposal.kind}`,
        sql`${event.payload}->'ai_proposal'->>'cooldown_key' = ${cooldownKey}`,
      ),
    );
  const proposalIds = [...new Set([...proposalRows.map((row) => row.id), proposal.id])];
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

  let acceptCount = 0;
  let dismissCount = 0;
  let latestDismiss: EventRow | null = null;
  for (const row of latestRateByProposal.values()) {
    const decision = decisionFromRate(row);
    if (decision === 'accept') {
      acceptCount += 1;
    } else if (decision === 'dismiss') {
      dismissCount += 1;
      latestDismiss = newerRate(latestDismiss, row);
    }
  }
  const total = acceptCount + dismissCount;
  if (total === 0) return;

  const acceptanceRate = acceptCount / total;
  const latestDismissPayload = (latestDismiss?.payload ?? {}) as { user_note?: unknown };
  const nextDismissReason = latestDismiss
    ? typeof latestDismissPayload.user_note === 'string'
      ? latestDismissPayload.user_note
      : latestDismiss.caused_by_event_id === proposal.id
        ? (dismissReason ?? null)
        : null
    : null;
  const cooldownUntilIso = latestDismiss
    ? dismissCooldownUntilFromRate(latestDismiss).toISOString()
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
