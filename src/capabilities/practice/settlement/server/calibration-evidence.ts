// 联合标定的证据入账 hook（ADR-0043 A4）。
//
// 在 settle 的 attempt tx SAVEPOINT 内写一条 difficulty_calibration_evidence：
// 跨题作答数据进标定的唯一入口。这是掌握更新，不是判分——judge event 仍是判分
// 真相源，本 hook 只读 (score, judge_route, provenance)，绝不回写。
//
// A4 取代旧 label hook 的三道排除：模型判分进标定（按复判一致率折权）；连续分数
// score ∈ (0,1) 直接进似然，unsupported / partial_unknown（分数未知）仍不进；
// 无 π_i 的非流内来源带来源标签进（无 π 就存 NULL，绝不伪造）。
//
// 旧 recordDifficultyCalibrationLabel 继续写 label 账本（既有契约 pin），但该账本
// 自 YUK-439 起只作审计面，不再喂标定批。
//
// D15/D16：manual / self_report / assisted 不进 hard mastery 与 calibration——
// caller 只在 plan.calibration 非空（automatic、非 assisted、分数已知）时调用。

import { and, desc, eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import {
  difficulty_calibration_evidence,
  practice_stream_item,
  selection_observation,
} from '@/db/schema';

/**
 * 作答来源解析（A4/A6.3 口径）。判别优先级：
 *   1. issuance 容器前缀（paper_* / placement: / probe: / ingestion: / worksheet:）
 *      —— 容器化作答（试卷/定位/探针/录入/导学案）先于流内判别。
 *   2. stream_item_id + 真 π_i（softmax_mfi selected 观测）→ 'stream_softmax'（存 π）。
 *   3. stream_item_id 但无 softmax 观测 → 'due'（到期/确定性放置，无 π 不伪造）。
 *   4. 都没有 → 'solo'（散题）。
 */
export interface ResolvedEvidenceOrigin {
  evidenceSource: string;
  inclusionProbability: number | null;
}

export async function resolveEvidenceOrigin(
  tx: Tx,
  input: { questionId: string; streamItemId?: string | null; containerRef?: string | null },
): Promise<ResolvedEvidenceOrigin> {
  const container = input.containerRef ?? null;
  if (container !== null) {
    if (container.startsWith('paper_'))
      return { evidenceSource: 'paper', inclusionProbability: null };
    if (container.startsWith('placement:'))
      return { evidenceSource: 'placement', inclusionProbability: null };
    if (container.startsWith('probe:'))
      return { evidenceSource: 'probe', inclusionProbability: null };
    if (container.startsWith('ingestion:'))
      return { evidenceSource: 'ingestion', inclusionProbability: null };
    if (container.startsWith('worksheet:'))
      return { evidenceSource: 'worksheet', inclusionProbability: null };
    // 未知前缀记原始值，批时落 unknown 权重；记 'solo' 会让来源权重虚高。
    return { evidenceSource: container, inclusionProbability: null };
  }
  if (input.streamItemId == null) {
    return { evidenceSource: 'solo', inclusionProbability: null };
  }
  // 流内 slot：按被答 slot 直 join 取放置该 slot 的 softmax 抽样 π_i（同 label hook
  // 的 YUK-372 L2 判别子），并确认 slot 仍活、仍属本题（race-guard）。
  const obsRows = await tx
    .select({ pi: selection_observation.inclusion_probability })
    .from(selection_observation)
    .where(
      and(
        eq(selection_observation.stream_item_id, input.streamItemId),
        eq(selection_observation.ref_id, input.questionId),
        eq(selection_observation.ref_kind, 'question'),
        eq(selection_observation.policy, 'softmax_mfi'),
        eq(selection_observation.selected, true),
      ),
    )
    .orderBy(desc(selection_observation.created_at))
    .limit(1);
  const pi = obsRows[0]?.pi ?? null;
  if (pi !== null && pi > 0 && pi <= 1) {
    const slotRows = await tx
      .select({ id: practice_stream_item.id })
      .from(practice_stream_item)
      .where(
        and(
          eq(practice_stream_item.id, input.streamItemId),
          eq(practice_stream_item.ref_id, input.questionId),
        ),
      )
      .limit(1);
    if (slotRows.length > 0) {
      return { evidenceSource: 'stream_softmax', inclusionProbability: pi };
    }
  }
  // 有被答 slot 但无真 softmax π（到期/legacy 确定性放置）→ 'due'。无 π 不伪造。
  return { evidenceSource: 'due', inclusionProbability: null };
}

export interface RecordDifficultyCalibrationEvidenceInput {
  /** 被标定题。 */
  questionId: string;
  /** 结算事件 id：去重锚 + revert 删行判别子。 */
  attemptEventId: string;
  /** 连续分数 ∈ [0,1]（verdict.normalized）；分数未知不进。 */
  score: number;
  /** 判分路由类（'exact' | 'contract_evaluation'）。 */
  judgeRoute: string | null | undefined;
  /** 判分自述置信；当前 settle 面未 sealed，通常 undefined。 */
  judgeConfidence?: number | null;
  /** 作答前的 θ̂。 */
  thetaBefore: number;
  /** 被答 slot 的 practice_stream_item.id；散题/容器作答为 null。 */
  streamItemId?: string | null;
  /** issuance 容器 ref（试卷/placement/probe/ingestion/worksheet）。 */
  containerRef?: string | null;
  now: Date;
}

/**
 * 写一条联合标定证据，或 skip。单条 upsert（onConflictDoNothing on attempt_event_id）
 * 无跨步副作用，可被 SAVEPOINT 吞而不留半写；caller 用 SAVEPOINT + try/catch 隔离。
 */
export async function recordDifficultyCalibrationEvidence(
  tx: Tx,
  input: RecordDifficultyCalibrationEvidenceInput,
): Promise<void> {
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
    // 分数未知/非法不进——「不造假分数」红线（A4）。caller 已挡 null，这里是护栏。
    return;
  }
  const origin = await resolveEvidenceOrigin(tx, {
    questionId: input.questionId,
    streamItemId: input.streamItemId,
    containerRef: input.containerRef,
  });
  await tx
    .insert(difficulty_calibration_evidence)
    .values({
      id: newId(),
      question_id: input.questionId,
      attempt_event_id: input.attemptEventId,
      theta_snapshot: input.thetaBefore,
      score: input.score,
      evidence_source: origin.evidenceSource,
      judge_route: input.judgeRoute ?? null,
      judge_confidence: input.judgeConfidence ?? null,
      inclusion_probability: origin.inclusionProbability,
      created_at: input.now,
    })
    .onConflictDoNothing({ target: difficulty_calibration_evidence.attempt_event_id });
}
