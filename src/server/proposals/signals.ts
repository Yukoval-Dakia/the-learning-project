import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { proposal_signals } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

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

function computeAcceptanceRate(acceptCount: number, dismissCount: number): number {
  const total = acceptCount + dismissCount;
  return total === 0 ? 0.5 : acceptCount / total;
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
  const existingRows = await db
    .select()
    .from(proposal_signals)
    .where(
      and(eq(proposal_signals.kind, proposal.kind), eq(proposal_signals.cooldown_key, cooldownKey)),
    )
    .limit(1);
  const existing = existingRows[0];

  const acceptCount = (existing?.accept_count ?? 0) + (decision === 'accept' ? 1 : 0);
  const dismissCount = (existing?.dismiss_count ?? 0) + (decision === 'dismiss' ? 1 : 0);
  const values = {
    accept_count: acceptCount,
    dismiss_count: dismissCount,
    acceptance_rate: computeAcceptanceRate(acceptCount, dismissCount),
    dismiss_reason:
      decision === 'dismiss' ? (dismissReason ?? null) : (existing?.dismiss_reason ?? null),
    cooldown_until: decision === 'dismiss' ? dismissCooldownUntil(now) : null,
    updated_at: now,
  };

  if (!existing) {
    await db.insert(proposal_signals).values({
      id: newId(),
      kind: proposal.kind,
      cooldown_key: cooldownKey,
      ...values,
      created_at: now,
    });
    return;
  }

  await db.update(proposal_signals).set(values).where(eq(proposal_signals.id, existing.id));
}
