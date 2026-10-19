// Sole writer of the kc_typed_state projection. Event-derived. Does not write FSRS.
// Each KC takes an advisory lock in `kc_typed:<subject_kind>:<id>`, a different hashtext
// namespace from mastery `fsrs:` and `mastery:` locks.
// `confused-with-X` is committed only when the probe discriminates, recurrence is at least 2,
// and the other KC is named. Otherwise the cell stays `no-evidence` / `open`.
// One failed probe can be the misconception or an unrelated cause.
// `mastered` is not produced here. That flip is deferred and not in Rust yet (ADR-0046).
//
// The `confused-with-X` branch is unreachable from production today. The only caller,
// reconcileConjecturePredictions, passes a null confused-with KC, and induction has no field
// to supply one. Before that null is cleared, induction must name the second KC and verify it
// exists. nextTypedState only checks that the id is truthy, and the column has no foreign key.
// Keep this conjunction strict. Relaxing it would store an unnamed confusion.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { kc_typed_state } from '@/db/schema';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';

export type TypedState = 'no-evidence' | 'confused-with-X' | 'mastered';
export type Lifecycle = 'open' | 'resolved';

/** Minimum distinct-attempt recurrence to commit a confused-with-X classification. */
export const CONFUSED_WITH_RECURRENCE_FLOOR = 2;

export interface NextTypedStateInput {
  proposed: 'confused-with-X' | 'no-evidence';
  /** Required to commit confused-with-X. Null keeps the cell soft. */
  confused_with_kc_id: string | null;
  /** True only when the probe isolates this misconception. */
  discriminating: boolean;
  recurrence_count: number;
}

export interface NextTypedStateResult {
  typed_state: TypedState;
  confused_with_kc_id: string | null;
  lifecycle: Lifecycle;
}

/**
 * `confused-with-X` needs a discriminating probe, recurrence at the floor, and a named KC.
 * Otherwise the cell stays soft. Never produces `mastered`.
 * Beating the baseline means the prediction fit this probe better. It does not confirm a misconception.
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

/**
 * Repair typed state when `fromId` is merged into `intoId`. Two repairs, both on the merge transaction.
 * The keyed row is renamed when only `fromId` exists, frozen when both exist, and left alone when
 * `fromId` is absent. Evidence is not unioned and the label is not recomputed.
 * Any row whose confused-with pointer names `fromId` is repointed at `intoId` in every case.
 * confused_with_kc_id is not in any unique constraint, so this update cannot hit one.
 * The return value describes the keyed row only.
 * Both ids are locked in this module's `kc_typed` namespace, sorted, so a concurrent upsert waits.
 *
 * The pointer update also touches rows keyed by other KCs, and those locks are not held.
 * Locking every possible pointer holder would be an unbounded set. A concurrent upsert that read
 * the old id can point back at the archived KC after this repair. The weekly orphan sweep already
 * matches `confused_with_kc_id`, so that stale pointer is detected and healed.
 */
export async function retireKcTypedStateOnMerge(
  tx: Tx,
  fromId: string,
  intoId: string,
  subjectKind = 'knowledge',
): Promise<'noop' | 'renamed' | 'frozen'> {
  await acquireSortedAdvisoryLocks(tx, `kc_typed:${subjectKind}`, [fromId, intoId]);
  // Display pointer. Repaired even when the keyed row is a no-op, a rename, or a freeze.
  await tx
    .update(kc_typed_state)
    .set({ confused_with_kc_id: intoId, updated_at: new Date() })
    .where(eq(kc_typed_state.confused_with_kc_id, fromId));

  const rows = await tx
    .select({ subject_id: kc_typed_state.subject_id })
    .from(kc_typed_state)
    .where(
      and(
        eq(kc_typed_state.subject_kind, subjectKind),
        inArray(kc_typed_state.subject_id, [fromId, intoId]),
      ),
    );
  const present = new Set(rows.map((r) => r.subject_id));
  if (!present.has(fromId)) return 'noop';
  if (!present.has(intoId)) {
    await tx
      .update(kc_typed_state)
      .set({ subject_id: intoId, updated_at: new Date() })
      .where(
        and(eq(kc_typed_state.subject_kind, subjectKind), eq(kc_typed_state.subject_id, fromId)),
      );
    return 'renamed';
  }
  console.warn(
    '[retireKcTypedStateOnMerge] both from+into have kc_typed_state — freezing from-row (no evidence merge)',
    { fromId, intoId },
  );
  return 'frozen';
}

export interface UpsertKcTypedStateInput {
  subject_id: string;
  subject_kind?: string;
  proposed: 'confused-with-X' | 'no-evidence';
  confused_with_kc_id?: string | null;
  discriminating: boolean;
  recurrence_count: number;
  /** Append-unioned into the stored provenance. A replay replace may drop ids instead. */
  evidence_event_ids: string[];
  last_evidence_at: Date;
}

export type ReplaceKcTypedStateInput = Omit<UpsertKcTypedStateInput, 'subject_id' | 'subject_kind'>;

/**
 * Replace one cell from a complete replay snapshot.
 * Unlike the append writer below, this may drop provenance or delete the cell when no evidence remains.
 */
export async function replaceKcTypedState(
  db: Db,
  subjectId: string,
  input: ReplaceKcTypedStateInput | null,
  subjectKind = 'knowledge',
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`kc_typed:${subjectKind}:${subjectId}`}))`,
    );
    if (!input) {
      await tx
        .delete(kc_typed_state)
        .where(
          and(
            eq(kc_typed_state.subject_kind, subjectKind),
            eq(kc_typed_state.subject_id, subjectId),
          ),
        );
      return;
    }
    const next = nextTypedState({
      proposed: input.proposed,
      confused_with_kc_id: input.confused_with_kc_id ?? null,
      discriminating: input.discriminating,
      recurrence_count: input.recurrence_count,
    });
    const now = new Date();
    const evidenceEventIds = [...new Set(input.evidence_event_ids)];
    await tx
      .insert(kc_typed_state)
      .values({
        id: newId(),
        subject_kind: subjectKind,
        subject_id: subjectId,
        typed_state: next.typed_state,
        confused_with_kc_id: next.confused_with_kc_id,
        lifecycle: next.lifecycle,
        evidence_event_ids: evidenceEventIds,
        last_evidence_at: input.last_evidence_at,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [kc_typed_state.subject_kind, kc_typed_state.subject_id],
        set: {
          typed_state: next.typed_state,
          confused_with_kc_id: next.confused_with_kc_id,
          lifecycle: next.lifecycle,
          evidence_event_ids: evidenceEventIds,
          last_evidence_at: input.last_evidence_at,
          updated_at: now,
        },
      });
  });
}

/**
 * Upsert one cell. The per-KC lock is how concurrent updates avoid losing provenance.
 * Evidence ids are append-unioned. Does not write FSRS or mastery.
 */
export async function upsertKcTypedState(db: Db, input: UpsertKcTypedStateInput): Promise<void> {
  const subjectKind = input.subject_kind ?? 'knowledge';
  await db.transaction(async (tx) => {
    // Released at transaction commit. Namespace is not mastery `fsrs:` or `mastery:`.
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
    // Do not move last_evidence_at backward when an out-of-order write carries an older time.
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
