// Selection telemetry writer: one row per sampled candidate.
// inclusion_probability is the π_i asset required for future active-PPI recalibration and is
// part of the backup FK order. Writing is best-effort and must never affect selection.

import { and, asc, eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { selection_observation } from '@/db/schema';
import { ApiError } from '@/kernel/http';

export interface SelectionObservationInput {
  /** 选题发生的本地日 YYYY-MM-DD（与 practice_stream_item.date 同度量）。 */
  date: string;
  /** 关联的流项 id（软引用 practice_stream_item.id）；候选层可空。 */
  streamItemId?: string;
  refKind: 'question' | 'paper';
  refId: string;
  /** 策略标识（'legacy'；Phase 3 起 'softmax_mfi'，见 selection-constants.ts）。 */
  policy: string;
  selected: boolean;
  /** 纳入概率 π_i ∈ (0, 1]。≤0 抛错（合法概率护栏）。 */
  inclusionProbability: number;
  /** 信号快照（SelectionCandidateSignal 形态，见 src/core/selection-signals.ts）。 */
  signals: Record<string, unknown>;
}

/**
 * 写一条选题观测。inclusion_probability 必须 ∈ (0, 1]——π_i 是合法概率，≤0 或 >1
 * 都是上游 bug，fail-fast 而非静默落脏数据（慢热资产不可被污染）。
 */
export async function recordSelectionObservation(
  db: Db | Tx,
  input: SelectionObservationInput,
): Promise<string> {
  const pi = input.inclusionProbability;
  if (!(pi > 0 && pi <= 1)) {
    throw new ApiError(
      'INVALID_INCLUSION_PROBABILITY',
      `inclusion_probability must be in (0, 1], got ${pi}`,
      400,
    );
  }
  const id = newId();
  await db.insert(selection_observation).values({
    id,
    date: input.date,
    stream_item_id: input.streamItemId ?? null,
    ref_kind: input.refKind,
    ref_id: input.refId,
    policy: input.policy,
    selected: input.selected,
    inclusion_probability: pi,
    signals: input.signals,
  });
  return id;
}

/**
 * 按日 + ref 取观测。
 * 按 created_at 升序——回放是时序语义（同一候选一天可多次观测），无 ORDER BY 时
 * Postgres 按堆序返回（VACUUM / 并行扫描后不确定），会破坏顺序敏感的重标定回放。
 */
export async function getSelectionObservations(db: Db, date: string, refId: string) {
  return db
    .select()
    .from(selection_observation)
    .where(and(eq(selection_observation.date, date), eq(selection_observation.ref_id, refId)))
    .orderBy(asc(selection_observation.created_at));
}
