// YUK-519 (A7 成效趋势面) — effectiveness-trend 只读纵向聚合读模型。
//
// 与姊妹「校准成熟度面」(calibration-maturity.ts) 正交：那面答「数据现在**多准**」
// （横截面快照：哪些 KC firm/冷启）；**本面答「相比过去**涨了吗**」**（纵向 delta：
// 同一 KC / 同一科目相对自己过去轨迹的方向 + 置信）。
//
// 数据来源：通用 `event` 表里的 `experimental:mastery_progress` 事件——每次作答成功
// per-KC 一条，payload 携本次 attempt 的 `theta_delta`(Δθ̂)/`p_learned`(当前 p(L))/
// `theta_hat`(当前 θ̂)，`subject_id`=KC id，`created_at`=纵向时间轴唯一锚。emit 站点见
// notes/server/mastery-progress-signal.ts（solo submit.ts + paper paper-submit.ts）。
// 本读模型是这些零散埋点的**第一个纵向聚合消费者**（此前零纵向读路径）。
//
// 红线（ADR-0035 三轴正交，同 mastery-progress-signal.ts:18-20）：**纯读 + 聚合，零写
// 路径**——绝不写回 mastery_state / item_calibration / FSRS。θ̂/p(L)/FSRS scheduling 不经
// 此路径回流。它是只读观测面，不是反馈环。只读现有列，不引入新 schema 字段（故不触
// audit:schema / audit:draft-status）。
//
// ⑥硬约束（gate doc §1.5.2 ⑥ + ADR-0035 §决定1）：趋势 delta **绝不裸数字**。本读模型
// 只输出**定性方向**（rising/holding/falling/insufficient）+ **置信档**（low/medium/high）
// + 证据量——不输出「掌握 +18%」这类裸 delta。趋势是「delta 的 delta」，置信比横截面更脆，
// n=1 慢热下大量 KC 长期低置信，故 `insufficient`/`low` 是一等公民态而非错误态。
//
// A7 owner 决策（开放题科目只显活动量代理）：IRT 三量退化 / 证据不足的 KC 不假装掌握度
// 趋势——`has_mastery_signal=false` 时让 UI 改走活动量代理（`activity_count` 始终内联提供）。

import { MASTERY_PROGRESS_ACTION } from '@/capabilities/notes/server/mastery-progress-signal';
import type { Db, Tx } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import {
  type EffectivenessTrendPoint,
  type EffectivenessTrendSummary,
  type TrendConfidence,
  type TrendDirection,
  numOrNull,
  rollupSubjectDirection,
  summarizeTrend,
} from './effectiveness-trend-summary';

// 纯趋势数学（常量 / 类型 / summarizeTrend / rollupSubjectDirection）已抽到 DB-free 的
// effectiveness-trend-summary.ts 以便落 no-DB unit 车道单测（本文件经 mastery-progress-signal
// 传递依赖 @/db/client，无法落 unit 分区）。此处只保留需要 schema 的读模型装配 + 派生轴。
// 向后兼容：重导出纯模块的公共类型 / summarizeTrend，既有 import 路径不变。
export type {
  EffectivenessTrendPoint,
  EffectivenessTrendSummary,
  TrendConfidence,
  TrendDirection,
} from './effectiveness-trend-summary';
export {
  EFFECT_RATIO_HIGH,
  EFFECT_RATIO_MEDIUM,
  FIRM_TREND_EVIDENCE,
  HOLDING_BAND_THETA,
  MIN_EVENTS_FOR_TREND,
  summarizeTrend,
} from './effectiveness-trend-summary';

type DbLike = Db | Tx;

export interface EffectivenessTrendSeries {
  knowledge_id: string;
  /** KC 名（knowledge.name）。KC 行缺失（已删）→ null。 */
  name: string | null;
  /** 派生科目轴（knowledge.domain → 沿 parent 链继承的 effective_domain）。无 → null。 */
  effective_domain: string | null;
  /** 按 created_at 升序的轨迹点。 */
  points: EffectivenessTrendPoint[];
  trend: EffectivenessTrendSummary;
  /** 该 KC 的 mastery_progress 事件总数 = 活动量代理（退化态下 UI 的兜底信号）。 */
  activity_count: number;
}

export interface SubjectTrendRollup {
  effective_domain: string | null;
  /** 该科目下有活动的 KC 中**主导**趋势方向；无可信信号的 KC → 该科目 `insufficient`。 */
  direction: TrendDirection;
  confidence: TrendConfidence;
  /** 该科目下有 mastery_progress 活动的 KC 数。 */
  kc_count: number;
  /** 其中有可信 mastery 趋势（has_mastery_signal）的 KC 数。0 → 退化/冷启，UI 走活动量代理。 */
  kc_with_mastery_signal: number;
  /** 该科目下 mastery_progress 事件总数 = 活动量代理。 */
  activity_count: number;
}

export interface EffectivenessTrendAggregate {
  /** 有 ≥1 条 mastery_progress 事件的 KC 总数。 */
  total_kcs_with_activity: number;
  /** mastery_progress 事件总数。 */
  total_events: number;
  /** 沿 effective_domain 派生轴的整科卷起。 */
  by_subject: SubjectTrendRollup[];
}

export interface EffectivenessTrendResponse {
  series: EffectivenessTrendSeries[];
  aggregate: EffectivenessTrendAggregate;
}

interface MasteryProgressEventRow {
  subject_id: string;
  created_at: Date;
  payload: Record<string, unknown>;
}

/**
 * 派生 effective_domain：沿 parent_id 链上溯到首个非空 domain（项目铁律「科目是派生视图，
 * 不在事件/KC 上存列」）。镜像 domain.ts:resolveSubjectKnowledgeIds / tree.ts 的内存 walk。
 * 此处用**全量** knowledge map（含已归档），保证有事件的 KC 名/域始终可解——观测面要展示历史
 * 轨迹，归档后仍要可见。带 seen 防环。
 */
function buildEffectiveDomainResolver(
  rows: Array<{ id: string; domain: string | null; parent_id: string | null }>,
): (id: string) => string | null {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (id: string): string | null => {
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.domain) return cur.domain;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return null;
  };
}

/**
 * Per-KC 纵向成效趋势读模型 + 沿派生科目轴的整科卷起。
 *
 * 把 `experimental:mastery_progress` 事件按 subject_id(KC) + created_at 聚成时间序列，每 KC
 * 算方向 + 置信（summarizeTrend），再沿 effective_domain 卷起。只读 event + knowledge 现有列，
 * 零写路径（红线）。
 */
export async function loadEffectivenessTrend(db: DbLike): Promise<EffectivenessTrendResponse> {
  // 全量 mastery_progress 事件，按 KC + 时间升序。单用户工具，事件量有界（同 tree.ts 的
  // load-all 姿态）——若日后增长需窗口化，是 follow-up。
  const events = (await db
    .select({
      subject_id: event.subject_id,
      created_at: event.created_at,
      payload: event.payload,
    })
    .from(event)
    .where(and(eq(event.action, MASTERY_PROGRESS_ACTION), eq(event.subject_kind, 'knowledge')))
    .orderBy(asc(event.subject_id), asc(event.created_at))) as MasteryProgressEventRow[];

  // KC 名 + effective_domain 派生底料：一次全量 knowledge 扫描（单用户，几百节点）。
  const knowledgeRows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
    })
    .from(knowledge);
  const nameById = new Map(knowledgeRows.map((r) => [r.id, r.name]));
  const resolveEffectiveDomain = buildEffectiveDomainResolver(knowledgeRows);

  // 按 KC 分组（events 已按 subject_id 排序，但用 Map 不依赖该假设）。
  const pointsByKc = new Map<string, EffectivenessTrendPoint[]>();
  for (const ev of events) {
    const points = pointsByKc.get(ev.subject_id) ?? [];
    points.push({
      at: ev.created_at.toISOString(),
      p_learned: numOrNull(ev.payload.p_learned),
      theta_hat: numOrNull(ev.payload.theta_hat),
      theta_delta: numOrNull(ev.payload.theta_delta),
    });
    pointsByKc.set(ev.subject_id, points);
  }

  const series: EffectivenessTrendSeries[] = [];
  for (const [knowledgeId, points] of pointsByKc) {
    // created_at 升序已由 query ORDER BY 保证，但显式再排一遍防 Map 迭代/同毫秒乱序。
    points.sort((a, b) => a.at.localeCompare(b.at));
    series.push({
      knowledge_id: knowledgeId,
      name: nameById.get(knowledgeId) ?? null,
      effective_domain: resolveEffectiveDomain(knowledgeId),
      points,
      trend: summarizeTrend(points),
      activity_count: points.length,
    });
  }
  // 确定性输出顺序（KC id 升序）。
  series.sort((a, b) => a.knowledge_id.localeCompare(b.knowledge_id));

  // 沿 effective_domain 卷起。null domain 归一桶（key ' '，与任何真实 domain 不冲突）。
  const NULL_DOMAIN = ' ';
  const bySubject = new Map<
    string,
    {
      effective_domain: string | null;
      trends: EffectivenessTrendSummary[];
      activity: number;
      kc: number;
    }
  >();
  for (const s of series) {
    const key = s.effective_domain ?? NULL_DOMAIN;
    const bucket = bySubject.get(key) ?? {
      effective_domain: s.effective_domain,
      trends: [],
      activity: 0,
      kc: 0,
    };
    bucket.trends.push(s.trend);
    bucket.activity += s.activity_count;
    bucket.kc += 1;
    bySubject.set(key, bucket);
  }

  const subjectRollups: SubjectTrendRollup[] = Array.from(bySubject.values()).map((bucket) => {
    const { direction, confidence } = rollupSubjectDirection(bucket.trends);
    return {
      effective_domain: bucket.effective_domain,
      direction,
      confidence,
      kc_count: bucket.kc,
      kc_with_mastery_signal: bucket.trends.filter((t) => t.has_mastery_signal).length,
      activity_count: bucket.activity,
    };
  });
  // 确定性顺序（domain 升序，null 排末尾）。
  subjectRollups.sort((a, b) => {
    if (a.effective_domain === b.effective_domain) return 0;
    if (a.effective_domain === null) return 1;
    if (b.effective_domain === null) return -1;
    return a.effective_domain.localeCompare(b.effective_domain);
  });

  return {
    series,
    aggregate: {
      total_kcs_with_activity: series.length,
      total_events: events.length,
      by_subject: subjectRollups,
    },
  };
}
