// YUK-348 (B1) — calibration-maturity 只读读模型：让 owner 观测 per-KC 的
// mastery-calibration「firm-up」（θ̂ 不确定性从冷启弱先验收紧到可信点估计的过程）。
//
// 纯 drizzle 读模型，零写路径，挂 observability 包（与 ai-observability.ts 同形态）。
// 只读现有列——不引入新 schema 字段，故不触 audit:schema / audit:draft-status。
//
// 数据来源（三轴正交红线 ADR-0035 — 这里只读诊断维，不碰 FSRS R 调度维）：
//   - mastery_state（per-KC，subject_kind='knowledge'，subject_id=knowledge.id）：
//       theta_precision → thetaSe(precision) 派生 θ̂ 标准误（schema 单一真相：
//       SE 不持久化，现算），evidence_count（K-schedule + credit-assignment 输入）。
//   - item_calibration（per-question，question_id 锚）：confidence / track。它是
//       **题级**标定，非 KC 级——故经 question.knowledge_ids @> [kc] 多对多聚合到
//       KC：avg(confidence) + 代表性 track（见 calibrationByKnowledge）。
//   - knowledge（id, name）：LEFT JOIN 基底——从未 attempt 的 KC（无 mastery_state
//       行）也要计入 cold_start（never attempted）。

import { thetaSe } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { item_calibration, knowledge, mastery_state, question } from '@/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

// ── cold_start 阈值规则（documented threshold）─────────────────────────────────
//
// 一个 KC 算「firm」（标定已收紧到可信）当且仅当它**同时**：
//   (1) evidence_count ≥ COLD_START_EVIDENCE_FLOOR，且
//   (2) theta_precision > COLD_START_PRECISION_CEILING。
// 否则算 cold_start。从未 attempt（LEFT JOIN 无 mastery_state 行）天然 cold_start。
//
// 选取理由（与 src/core/theta.ts 的标定常量对齐，非任意拍）：
//   - EVIDENCE_FLOOR = 4 = theta.ts 的 `coldStartN`（eloK 冷启段长度）。该段 θ̂ 由
//     LLM 先验主导、K 大、最不该被当成已收敛——正是「冷启」语义本身。
//   - PRECISION_CEILING = 1.0 = mastery_state.theta_precision 的 DEFAULT（弱先验 1
//     单位信息，SE=1）。precision 仍卡在 ≤1 意味着累积 Fisher information 没超过
//     初始弱先验——θ̂ 标准误未收紧，标定未 firm。> 1 才说明真实作答信息已盖过先验。
// 两条 AND：既要够多次作答（evidence），又要 θ̂ 不确定性真收紧（precision），单独
// 任一条都可能误判（高 evidence 但题难度全脱靶 → precision 不涨；或反之）。
export const COLD_START_EVIDENCE_FLOOR = 4;
export const COLD_START_PRECISION_CEILING = 1.0;

function isColdStart(evidenceCount: number, thetaPrecision: number, hasState: boolean): boolean {
  if (!hasState) return true; // never attempted
  return (
    evidenceCount < COLD_START_EVIDENCE_FLOOR || thetaPrecision <= COLD_START_PRECISION_CEILING
  );
}

export interface CalibrationMaturityRow {
  knowledge_id: string;
  name: string;
  /** mastery_state.evidence_count；从未 attempt 的 KC 为 0。 */
  evidence_count: number;
  /** thetaSe(theta_precision)——θ̂ 标准误，现算（不持久化）。无 mastery_state 行 → null。 */
  theta_se: number | null;
  /** 该 KC 关联题（question.knowledge_ids @> [kc]）的 item_calibration 平均 confidence。无标定题 → null。 */
  confidence: number | null;
  /** 该 KC 关联题的代表性 track（见 calibrationByKnowledge 的 dominant-track 规则）。无标定题 → null。 */
  track: string | null;
  cold_start: boolean;
}

export interface CalibrationMaturityAggregate {
  total_kcs: number;
  cold_start_count: number;
  firm_count: number;
  /** firm_count / total_kcs，0..1，保 4 位小数。total_kcs=0 → 0。 */
  pct_firm: number;
  /** 全图 theta_se 中位数（仅计有 mastery_state 行的 KC）。无任何行 → null。 */
  median_theta_se: number | null;
}

export interface CalibrationMaturityResponse {
  rows: CalibrationMaturityRow[];
  aggregate: CalibrationMaturityAggregate;
}

interface KcCalibration {
  /** avg(confidence) over the KC's calibrated questions whose confidence is set. */
  confidence: number | null;
  /** dominant track among the KC's calibrated questions. */
  track: string | null;
}

/**
 * Per-KC aggregation of item_calibration through question.knowledge_ids.
 *
 * item_calibration is per-question; this view is per-KC. We join each calibration
 * row to the KCs of its question (knowledge_ids array) and, per KC, compute:
 *   - confidence = avg(item_calibration.confidence) over rows whose confidence is set,
 *   - track      = the most frequent track (MODE; deterministic alphabetical fallback).
 * Returns a Map keyed by knowledge_id; KCs with no calibrated question are absent.
 */
async function calibrationByKnowledge(db: DbLike): Promise<Map<string, KcCalibration>> {
  // Unnest each question's knowledge_ids array, join to its item_calibration row,
  // then group by KC. confidence avg ignores NULLs; track picks the mode.
  const rows = await db
    .select({
      knowledge_id: sql<string>`kc.kc_id`,
      avg_confidence: sql<number | null>`AVG(${item_calibration.confidence})`,
      track_first: sql<
        string | null
      >`(ARRAY_AGG(${item_calibration.track} ORDER BY ${item_calibration.track}))[1]`,
      track_mode: sql<string | null>`MODE() WITHIN GROUP (ORDER BY ${item_calibration.track})`,
    })
    .from(item_calibration)
    .innerJoin(question, eq(question.id, item_calibration.question_id))
    .innerJoin(
      sql`LATERAL jsonb_array_elements_text(${question.knowledge_ids}) AS kc(kc_id)`,
      sql`true`,
    )
    .groupBy(sql`kc.kc_id`);

  const out = new Map<string, KcCalibration>();
  for (const row of rows) {
    out.set(row.knowledge_id, {
      confidence: row.avg_confidence === null ? null : Number(row.avg_confidence),
      // MODE() gives the dominant track; ARRAY_AGG[1] is a deterministic tiebreak
      // fallback (track is NOT NULL so MODE is always populated, but keep it defensive).
      track: row.track_mode ?? row.track_first,
    });
  }
  return out;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Per-KC calibration-maturity read model + whole-map aggregate.
 *
 * LEFT JOIN knowledge → mastery_state so every non-archived KC appears; KCs with
 * no mastery_state row (never attempted) are classified cold_start with theta_se
 * = null and evidence_count = 0.
 */
export async function loadCalibrationMaturity(db: DbLike): Promise<CalibrationMaturityResponse> {
  const baseRows = await db
    .select({
      knowledge_id: knowledge.id,
      name: knowledge.name,
      evidence_count: mastery_state.evidence_count,
      theta_precision: mastery_state.theta_precision,
      has_state: sql<boolean>`(${mastery_state.id} IS NOT NULL)`,
    })
    .from(knowledge)
    .leftJoin(
      mastery_state,
      and(eq(mastery_state.subject_id, knowledge.id), eq(mastery_state.subject_kind, 'knowledge')),
    )
    // Archived KCs are not part of the live calibration surface.
    .where(isNull(knowledge.archived_at))
    .orderBy(knowledge.id);

  const calibration = await calibrationByKnowledge(db);

  const rows: CalibrationMaturityRow[] = baseRows.map((row) => {
    const hasState = row.has_state;
    const evidenceCount = hasState ? (row.evidence_count ?? 0) : 0;
    const thetaPrecision = hasState ? (row.theta_precision ?? 1) : 1;
    const cal = calibration.get(row.knowledge_id);
    return {
      knowledge_id: row.knowledge_id,
      name: row.name,
      evidence_count: evidenceCount,
      theta_se: hasState ? thetaSe(thetaPrecision) : null,
      confidence: cal?.confidence ?? null,
      track: cal?.track ?? null,
      cold_start: isColdStart(evidenceCount, thetaPrecision, hasState),
    };
  });

  const totalKcs = rows.length;
  const coldStartCount = rows.filter((r) => r.cold_start).length;
  const firmCount = totalKcs - coldStartCount;
  const pctFirm = totalKcs === 0 ? 0 : Math.round((firmCount / totalKcs) * 10_000) / 10_000;
  const seValues = rows
    .map((r) => r.theta_se)
    .filter((se): se is number => se !== null)
    .sort((a, b) => a - b);

  return {
    rows,
    aggregate: {
      total_kcs: totalKcs,
      cold_start_count: coldStartCount,
      firm_count: firmCount,
      pct_firm: pctFirm,
      median_theta_se: median(seValues),
    },
  };
}
