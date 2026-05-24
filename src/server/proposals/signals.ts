import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { proposal_signals } from '@/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

export const PROPOSAL_DISMISS_COOLDOWN_DAYS = 7;

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

export async function ensureProposalDecisionSignal(
  db: DbLike,
  proposal: ProposalSignalSource,
  decision: 'accept' | 'dismiss',
  dismissReason?: string,
): Promise<void> {
  const cooldownKey = proposal.payload.cooldown_key;
  if (!cooldownKey) return;
  const lockKey = `${proposal.kind}:${cooldownKey}`;
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

  const existing = (
    await db
      .select({
        accept_count: proposal_signals.accept_count,
        dismiss_count: proposal_signals.dismiss_count,
      })
      .from(proposal_signals)
      .where(
        and(
          eq(proposal_signals.kind, proposal.kind),
          eq(proposal_signals.cooldown_key, cooldownKey),
        ),
      )
      .limit(1)
  )[0];
  if (existing && existing.accept_count + existing.dismiss_count > 0) return;

  await recordProposalDecisionSignal(db, proposal, decision, dismissReason);
}
