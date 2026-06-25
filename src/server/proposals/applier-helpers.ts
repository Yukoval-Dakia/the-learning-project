// M4-T4 (YUK-319) — shared accept-applier helpers, extracted verbatim from
// actions.ts so per-capability proposal-appliers (practice / agency / ingestion
// / knowledge / notes) can import them WITHOUT importing actions.ts itself.
// The import-cycle gate forbids capability appliers from importing
// producers/writer/actions; this file is the sanctioned shared surface.

import { and, eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { ApiError } from '@/server/http/errors';

type DbLike = Db | Tx;

export type ExistingRateDecision = 'accept' | 'dismiss' | 'reverse' | 'change_type' | 'rollback';

// YUK-471 (retract fold/rollback) — accepts Db | Tx so a caller (retractAiProposal) can read
// the existing rate event INSIDE its single retract transaction (consistent snapshot). It is a
// pure read of an immutable historical event row, so widening is safe; existing Db callers are
// unaffected (Db is assignable to DbLike).
export async function findExistingRateEvent(
  db: DbLike,
  proposalId: string,
): Promise<(typeof event.$inferSelect & { decision: ExistingRateDecision }) | null> {
  const existingRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existing = existingRows[0];
  const rating = (existing?.payload as { rating?: unknown } | undefined)?.rating;
  if (
    !existing ||
    (rating !== 'accept' &&
      rating !== 'dismiss' &&
      rating !== 'reverse' &&
      rating !== 'change_type' &&
      rating !== 'rollback')
  ) {
    return null;
  }
  const decision: ExistingRateDecision = rating;
  return Object.assign(existing, { decision });
}

export async function existingAcceptRate(
  db: Db,
  proposalId: string,
): Promise<(typeof event.$inferSelect & { decision: ExistingRateDecision }) | null> {
  const existingRate = await findExistingRateEvent(db, proposalId);
  if (!existingRate) return null;
  if (existingRate.decision !== 'accept') {
    throw new ApiError(
      'conflict',
      `proposal ${proposalId} already decided as ${existingRate.decision}`,
      409,
    );
  }
  return existingRate;
}

// Structural-minimal opts shape: appliers only ever inspect `decision`, and
// the dispatch shell's AcceptAiProposalOpts is structurally assignable to it.
export function ensureAcceptOnly(kind: string, opts: { decision?: string }): void {
  if (opts.decision && opts.decision !== 'accept') {
    throw new ApiError('validation_error', `${kind} proposal only supports accept`, 400);
  }
}

export function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function requiredString(value: unknown, field: string, proposalId: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new ApiError(
    'validation_error',
    `proposal ${proposalId} is missing required proposed_change.${field}`,
    400,
  );
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
