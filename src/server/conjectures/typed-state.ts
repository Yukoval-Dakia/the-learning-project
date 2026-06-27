// YUK-440 (A13 typed KC ledger) — single-writer for kc_typed_state.
//
// The ONLY writer of the kc_typed_state projection. Pure event-derived (no FSRS write —
// ND-5). Serializes per-KC via an advisory lock in an INDEPENDENT namespace
// `kc_typed:<subject_kind>:<id>` (distinct hashtext keyspace from mastery_state's
// `fsrs:`/`mastery:` locks — no collision). §修正-4 gate: `confused-with-X` is committed
// ONLY when a discriminating probe AND recurrence≥2 confirm it; otherwise the cell stays
// soft (`no-evidence`, `open`) awaiting a second confirmation — a single failed probe
// could be the misconception OR an unrelated cause (YUK-344 consistency-gate territory,
// deliberately conservative in Phase 0). `mastered` is NOT produced here — it is the
// post-Rust-scorer claim-survival FLIP (ADR-0046), deferred.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { kc_typed_state } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export type TypedState = 'no-evidence' | 'confused-with-X' | 'mastered';
export type Lifecycle = 'open' | 'resolved';

/** Minimum distinct-attempt recurrence to commit a confused-with-X classification. */
export const CONFUSED_WITH_RECURRENCE_FLOOR = 2;

export interface NextTypedStateInput {
  /** the classification a resolved probe proposes. */
  proposed: 'confused-with-X' | 'no-evidence';
  /** the KC the learner is confused with (required for a confused-with-X commit). */
  confused_with_kc_id: string | null;
  /** the conjecture's probe was discriminating (isolates THIS misconception). */
  discriminating: boolean;
  /** distinct-attempt recurrence backing the conjecture. */
  recurrence_count: number;
}

export interface NextTypedStateResult {
  typed_state: TypedState;
  confused_with_kc_id: string | null;
  lifecycle: Lifecycle;
}

/**
 * §修正-4 gate (PURE). `confused-with-X` requires a discriminating probe AND
 * recurrence ≥ CONFUSED_WITH_RECURRENCE_FLOOR AND a named confused_with KC; otherwise the
 * cell stays soft (`no-evidence` / `open`). Never produces `mastered` (FLIP is deferred,
 * ADR-0046). NOTE: even post-Rust-scorer, beating baseline only licenses "the qualitative
 * track predicts this learner's probe outcome better" — NOT "misconception confirmed".
 */
export function nextTypedState(input: NextTypedStateInput): NextTypedStateResult {
  if (
    input.proposed === 'confused-with-X' &&
    input.discriminating &&
    input.recurrence_count >= CONFUSED_WITH_RECURRENCE_FLOOR &&
    input.confused_with_kc_id
  ) {
    return {
      typed_state: 'confused-with-X',
      confused_with_kc_id: input.confused_with_kc_id,
      lifecycle: 'resolved',
    };
  }
  return { typed_state: 'no-evidence', confused_with_kc_id: null, lifecycle: 'open' };
}

export interface UpsertKcTypedStateInput {
  subject_id: string;
  subject_kind?: string;
  proposed: 'confused-with-X' | 'no-evidence';
  confused_with_kc_id?: string | null;
  discriminating: boolean;
  recurrence_count: number;
  /** event ids backing this update (append-union into evidence_event_ids). */
  evidence_event_ids: string[];
  last_evidence_at: Date;
}

/**
 * Single-writer upsert of one (subject_kind, subject_id) typed-state row. Takes its own
 * advisory lock (independent namespace) so concurrent updates of the same KC serialize
 * with no lost evidence. Append-unions evidence_event_ids; advances last_evidence_at.
 * Purely event-derived — writes NO FSRS / mastery_state state (ND-5).
 */
export async function upsertKcTypedState(db: Db, input: UpsertKcTypedStateInput): Promise<void> {
  const subjectKind = input.subject_kind ?? 'knowledge';
  await db.transaction(async (tx) => {
    // Serialize per-KC in an INDEPENDENT namespace (distinct hashtext keyspace → no
    // collision with mastery_state's fsrs:/mastery: locks). Released at tx commit.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`kc_typed:${subjectKind}:${input.subject_id}`}))`,
    );
    const existing = await tx
      .select({
        evidence_event_ids: kc_typed_state.evidence_event_ids,
        last_evidence_at: kc_typed_state.last_evidence_at,
      })
      .from(kc_typed_state)
      .where(
        and(
          eq(kc_typed_state.subject_kind, subjectKind),
          eq(kc_typed_state.subject_id, input.subject_id),
        ),
      )
      .limit(1);
    const prevEvidence = existing[0]?.evidence_event_ids ?? [];
    const mergedEvidence = [...new Set([...prevEvidence, ...input.evidence_event_ids])];
    // last_evidence_at is monotonic — never regress it if an out-of-order write carries an
    // older timestamp. The §修正-3 projection is in-order single-writer, but GREATEST keeps
    // it correct (and replayable) under any ordering.
    const prevLastEvidenceAt = existing[0]?.last_evidence_at ?? null;
    const lastEvidenceAt =
      prevLastEvidenceAt && prevLastEvidenceAt > input.last_evidence_at
        ? prevLastEvidenceAt
        : input.last_evidence_at;
    const next = nextTypedState({
      proposed: input.proposed,
      confused_with_kc_id: input.confused_with_kc_id ?? null,
      discriminating: input.discriminating,
      recurrence_count: input.recurrence_count,
    });
    const now = new Date();
    await tx
      .insert(kc_typed_state)
      .values({
        id: newId(),
        subject_kind: subjectKind,
        subject_id: input.subject_id,
        typed_state: next.typed_state,
        confused_with_kc_id: next.confused_with_kc_id,
        lifecycle: next.lifecycle,
        evidence_event_ids: mergedEvidence,
        last_evidence_at: lastEvidenceAt,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [kc_typed_state.subject_kind, kc_typed_state.subject_id],
        set: {
          typed_state: next.typed_state,
          confused_with_kc_id: next.confused_with_kc_id,
          lifecycle: next.lifecycle,
          evidence_event_ids: mergedEvidence,
          last_evidence_at: lastEvidenceAt,
          updated_at: now,
        },
      });
  });
}
