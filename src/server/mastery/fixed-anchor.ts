// Cold-start inc-A: owner FIXED-ANCHOR write path (item_calibration
// source='fixed_anchor'). Design: docs/design/2026-06-20-cold-start-day-one-design.md
// §5 inc-A / §4.1.
//
// LLM difficulty estimates carry a systematic offset, and n=1 has no population to
// calibrate against. The one legal offset lever is a small owner-chosen anchor set that
// fixes the scale's origin and unit.
//
// Write-only: this module writes item_calibration.{b, b_anchor}. The read path already
// prefers a non-null anchor via effectiveB, so it needs no change. This never runs on the
// attempt path, and online θ̂ never writes b.
//
// Single-writer contract: item_calibration inserts/updates stay in src/server/mastery/;
// API routes call setFixedAnchor instead of touching the table.
//
// Upsert vs applyItemPrior's write-once: the owner may revise an anchor, so re-setting a
// question overwrites b/b_anchor/source and resets the posterior to the new prior without
// clearing the evidence ledger. Soft columns stay NULL (n=1 cannot estimate them).

import { priorTau } from '@/core/difficulty-posterior';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { item_calibration } from '@/db/schema';

type DbLike = Db | Tx;

// bucket → logit b, an owner-fixed prior (not estimated): five ordinal buckets on a
// symmetric [-2, +2] scale. Owners give relative order, which is the real signal; the
// table pins that order to the common 1PL scale.
export const ANCHOR_BUCKET_LOGITS = {
  very_easy: -2,
  easy: -1,
  medium: 0,
  hard: 1,
  very_hard: 2,
} as const;

export type AnchorBucket = keyof typeof ANCHOR_BUCKET_LOGITS;

/** 五档桶名（运行时校验 / Zod enum 来源）。 */
export const ANCHOR_BUCKETS = Object.keys(ANCHOR_BUCKET_LOGITS) as AnchorBucket[];

/** bucket → 固定 logit b。owner-fixed，非估计。未知桶名 throw（上游 Zod 应已挡住）。 */
export function bucketToLogit(bucket: AnchorBucket): number {
  const b = ANCHOR_BUCKET_LOGITS[bucket];
  if (b === undefined) {
    throw new Error(`bucketToLogit: unknown anchor bucket '${bucket}'`);
  }
  return b;
}

export interface FixedAnchorInput {
  questionId: string;
  bucket: AnchorBucket;
}

export interface FixedAnchorRow {
  questionId: string;
  bucket: AnchorBucket;
  b: number;
}

/**
 * Persist (upsert) an owner-declared fixed difficulty anchor.
 *
 * Writes { b, b_anchor, track:'hard', source:'fixed_anchor' }. Re-setting the same
 * question is an UPDATE (the owner revises the bucket), never a duplicate row. A revised
 * anchor also resets the posterior to the new prior; the evidence ledger is kept, so the
 * next calibration batch re-converges from existing evidence.
 */
export async function setFixedAnchor(db: DbLike, input: FixedAnchorInput): Promise<FixedAnchorRow> {
  const now = new Date();
  const b = bucketToLogit(input.bucket);
  const tau = priorTau('fixed_anchor');
  await db
    .insert(item_calibration)
    .values({
      id: newId(),
      question_id: input.questionId,
      // b 与 b_anchor 同源；effectiveB 经 b_post 读。
      b,
      b_anchor: b,
      // Owner anchors are high-confidence priors, not LLM guesses.
      confidence: 1,
      track: 'hard',
      source: 'fixed_anchor',
      // 初始化后验 = 先验（fixed_anchor 的 τ 最小，强 leash）。
      b_post: b,
      posterior_variance: tau * tau,
      calibration_source: 'prior',
      created_at: now,
      updated_at: now,
    })
    // 幂等 upsert：改档 = 修订先验；created_at 保留首写值。
    .onConflictDoUpdate({
      target: item_calibration.question_id,
      set: {
        b,
        b_anchor: b,
        confidence: 1,
        track: 'hard',
        source: 'fixed_anchor',
        b_post: b,
        posterior_variance: tau * tau,
        calibration_source: 'prior',
        updated_at: now,
      },
    });
  return { questionId: input.questionId, bucket: input.bucket, b };
}

/**
 * Set several fixed anchors in one transaction. Any failure rolls back the whole batch:
 * a half-applied anchor set is worse than none because the scale would mix owner truth
 * with LLM offsets. Takes `Db` because only it exposes `.transaction`; the single-anchor
 * writer stays `DbLike` and also works inside this tx.
 */
export async function setFixedAnchors(
  db: Db,
  inputs: ReadonlyArray<FixedAnchorInput>,
): Promise<FixedAnchorRow[]> {
  return db.transaction(async (tx) => {
    const out: FixedAnchorRow[] = [];
    for (const input of inputs) {
      out.push(await setFixedAnchor(tx, input));
    }
    return out;
  });
}
