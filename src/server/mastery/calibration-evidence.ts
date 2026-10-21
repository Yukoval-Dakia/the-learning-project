// YUK-439 (ADR-0043 2026-10-19 Amendment A4) — 联合标定的证据入账 hook。
//
// ─── 这层做什么 ─────────────────────────────────────────────────────────────
// 在一次结算（settle 的 attempt tx SAVEPOINT 内，同 label hook 的 tx-abort 隔离纪律）
// 上写一条 difficulty_calibration_evidence：**跨题作答数据进标定的唯一入口**。
// 这是掌握更新（mastery update），**不是答案判分**——judge event 仍是判分真相源，
// 本 hook 只读 (score, judge_route, provenance) 绝不回写判分；判分设计零改动。
//
// ─── 与旧 label hook 的差别（A4 明文取代的三道排除）─────────────────────────
//   - 旧「非 objective 路由 early-return 排除」→ 模型判分（contract_evaluation）进
//     标定，批时以 w_e = 复判一致率 × judge confidence 折可靠度。
//   - 旧「partial 一律排除」→ score ∈ (0,1) 连续证据直接进似然（0/1 特例）；
//     unsupported / partial_unknown（分数未知）仍不进——「不造假分数」红线。
//   - 旧「无 streamItemId（无 π_i）→ skip」→ 非 softmax 来源（散题/试卷/placement/
//     probe/ingestion）作为带来源标签的似然证据直接进，批时乘来源权重（保守起步，
//     低于流内选题）。π_i 只在 PPI 池估计器下是必需的 IPW 校正；联合标定下每条作答
//     是直接似然观测——原红线的精神保留为**绝不伪造 π_i**（无 π 就存 NULL）。
//
// 旧 recordDifficultyCalibrationLabel 保持原样继续写 label 账本（行为被既有契约
// pin）；label 账本自 YUK-439 起只作审计面，不再喂标定批。
//
// ─── D15/D16 排除（不变）────────────────────────────────────────────────────
// manual / self_report / assisted 的证据被排除在 hard mastery（θ̂）与 calibration
// 之外——caller（settle.ts）只在 plan.calibration 非空（automatic 且非 assisted 且
// 分数已知）时调用本 hook。

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
    // 未知容器前缀：保守按来源权重最低档处理（EVIDENCE_SOURCE_WEIGHT_UNKNOWN），
    // 不猜具体来源。evidence_source 记 'solo' 会让权重虚高，这里直接显式落 unknown 桶：
    // 存 'solo' 之外的最保守标签没有对应枚举，故记原始前缀本身（批时落 unknown 权重）。
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
  /** 被标定题（question.id）。 */
  questionId: string;
  /** 结算事件 id（去重锚 + revert 删行判别子；同 label hook 的 attempt_event_id 语义）。 */
  attemptEventId: string;
  /** 连续分数 ∈ [0,1]（verdict.normalized）。caller 保证非 null（分数未知不进）。 */
  score: number;
  /** 判分路由类（settle 面 plan.judgeRoute：'exact' | 'contract_evaluation'）。 */
  judgeRoute: string | null | undefined;
  /** 判分自述置信（当前 settle 面未 sealed → 通常 undefined；列备未来直接补）。 */
  judgeConfidence?: number | null;
  /** 作答时（PRE-attempt）的 θ̂（primary KC offset，同 thetaBefore 纪律）。 */
  thetaBefore: number;
  /** 被答 slot 的 practice_stream_item.id（流内作答传；散题/容器作答 null）。 */
  streamItemId?: string | null;
  /** issuance 容器 ref（试卷/placement/probe/ingestion/worksheet）。 */
  containerRef?: string | null;
  now: Date;
}

/**
 * 写一条联合标定证据，或 skip。单条 upsert（onConflictDoNothing on attempt_event_id），
 * 无跨步副作用 → 被 SAVEPOINT 吞而不留半写。绝不抛错冒泡打断 attempt 主路径
 * （caller 用 SAVEPOINT + try/catch 兜底，同 label hook 纪律）。
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
