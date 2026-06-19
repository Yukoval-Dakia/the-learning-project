// B1 four-engine soft-track inc-1 (YUK-348, ADR-0035 决定 #3 + 决定 #4 红线) —
// 软轨 KT 估计的夜间触发器（clones recalibration_nightly skeleton）。
//
// estimateBkt（纯 BKT forward）+ applyKtEstimate（kt_json sink）建好但无在线 caller——
// 软轨绝不在 attempt 路径产出（红线 #4：不喂决策，故不挂在线热路径）。本 job 是它们的
// **离线触发器**：每夜扫「有硬轨 item_calibration 行 + 有非空作答序列」的非 draft 题，逐题
// 读其 event 作答序列 → estimateBkt → applyKtEstimate 落 kt_json。
//
// 结构上仿 recalibration_nightly.ts：候选 SELECT（pre-write DB read，throw 冒泡 → pg-boss
// 重试）→ 逐题 await（读序列 + estimateBkt + applyKtEstimate），单题 throw 被 per-question
// try/catch 吞（不阻断其余题）。本 job 在顶层调（NOT 嵌在 attempt tx）→ per-question try/catch
// 即足够隔离，不加 SAVEPOINT（G1：不在 attempt tx 里）。
//
// ─── 红线（ADR-0035 决定 #4）：kt_json 是纯持久化 sink ──────────────────────────
// applyKtEstimate 只 UPDATE kt_json（track='hard'），never b / b_anchor / b_calib / confidence /
// 其它软轨列。kt_json 零下游消费者（不喂 p(L)/调度/显示）。本 job 不新增任何其它写。
//
// ─── 客观判分门（与硬轨 b 标定同纪律）─────────────────────────────────────────
// KT 估计只消费**客观判分**驱动的二元 outcome（success/failure）。attempt/review 事件本身的
// outcome 字段不能直接当客观真值——散题（submit.ts）/ 卷面（paper-submit.ts）的 review 事件
// outcome 由 FSRS rating 派生（`again→failure`, `hard/good/easy→success`），**手评也写
// success/failure**（auto_rate=false 路径）；散题复习 `ReviewOnQuestion` 同样从 FSRS rating
// 派生。把这些主观/FSRS-derived outcome 喂 BKT 会让 KT 画像吃用户主观评分噪声——和硬轨
// `recalibration_nightly` 不直接读 event outcome、而是读 `difficulty_calibration_label` 表
// （其 write path `recordDifficultyCalibrationLabel` 用 `isObjectiveJudgeRoute` 早返守门）
// 是同一道红线。
//
// 客观判分的权威链（与 `personalized-difficulty.ts countDistinctQuestionsInFamily` 同范式）：
// attempt/review 事件外，**还有一条独立 judge 事件** `action='judge' AND subject_kind='event'`，
// `caused_by_event_id = <attempt/review event_id>`，`payload.judge_route ∈ OBJECTIVE_JUDGE_ROUTES
// (= {'exact','keyword'})`。客观门 = 仅接受被这样一条 objective judge 事件**锚定**的
// attempt/review 事件进 KT 序列。LLM 路由（semantic/rubric/steps/ai_flexible...）+ 手评
// （无 judge 事件 / judge_route 不在白名单）一律排除。
//
// ─── 候选预筛 ───────────────────────────────────────────────────────────────
// 候选 = 「该题有硬轨 item_calibration 行（track='hard'）」AND「question 非 draft（G5）」AND
//   「该题有 ≥1 条**被客观 judge 事件锚定的**二元 attempt/review 事件（outcome ∈
//   {'success','failure'} 且 objective-judge-anchored）」。三条都满足才入选——
//   无硬轨行 → applyKtEstimate no-op（不浪费）；draft → 不该被标定（belt-and-suspenders）；
//   无客观锚序列 → 不该有 KT 画像（主观评分不该塑形 KT 参数）省开销。partial outcome 不算二元
//   （与硬轨 difficulty 标签同纪律，见序列读取）。

import type { Db } from '@/db/client';
import { event, item_calibration, question } from '@/db/schema';
import { applyKtEstimate } from '@/server/mastery/kt-calibration';
import { estimateBkt } from '@/server/mastery/kt-estimator';
import { OBJECTIVE_JUDGE_ROUTES } from '@/server/mastery/personalized-difficulty';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

type DepsOverride = {
  /** 每轮最多估多少题（防一次 job 打爆）。default 500。 */
  maxPerRun?: number;
};

export interface KtEstimateNightlyResult {
  /** 本轮挑出的候选题数（capped by maxPerRun）。 */
  considered: number;
  /** 成功写入 kt_json 的题数（applyKtEstimate 实际 UPDATE 到硬轨行）。 */
  estimated: number;
  /** 单题 estimateBkt/applyKtEstimate 抛错被跳过的题数（不阻断其余题）。 */
  skipped_failed: number;
}

const DEFAULT_MAX_PER_RUN = 500;

/**
 * 构造「该 attempt/review 事件被一条 objective judge 事件锚定」的 SQL 片段（Drizzle raw sql）。
 *
 * 范式与 `personalized-difficulty.ts countDistinctQuestionsInFamily` 完全一致：judge 事件
 * `action='judge' AND subject_kind='event' AND caused_by_event_id = <外层 ev>.id AND
 * payload->>'judge_route' IN OBJECTIVE_JUDGE_ROUTES`。白名单常量来自单一真相源（不在本文件
 * 复述——避免两处漂移）。`outerAlias` 是**外层** attempt/review 事件的表别名/表名，用于
 * `caused_by_event_id` 引用——readOutcomeSeq 主 FROM 用 `'event'`（drizzle 默认表名 alias），
 * 候选预筛外层 EXISTS 内层用 `'ev'`（该子查询的 event 别名）。alias 由本模块内部控制，
 * 非用户输入，故 `sql.raw` 安全。
 */
function objectiveJudgeAnchorExists(outerAlias: string) {
  const routeList = sql.join(
    [...OBJECTIVE_JUDGE_ROUTES].map((r) => sql`${r}`),
    sql`, `,
  );
  return sql`EXISTS (
    SELECT 1 FROM ${event} AS judge
    WHERE judge.action = 'judge'
      AND judge.subject_kind = 'event'
      AND judge.caused_by_event_id = ${sql.raw(outerAlias)}.id
      AND judge.payload->>'judge_route' IN (${routeList})
  )`;
}

/**
 * 读一道题的客观二元作答序列（0/1，按时间顺序）。
 *
 * 权威落点 = attempt/review 事件（`subject_kind='question', subject_id=questionId,
 * action IN ('review','attempt')`），`outcome` ∈ {'success','failure'}（partial / NULL 排除——
 * 部分对/无判分对 BKT 二元似然语义歧义，同硬轨 difficulty 标签纪律）。按 created_at 升序。
 *
 * **客观门**：仅接受被一条 objective judge 事件（`payload.judge_route ∈
 * OBJECTIVE_JUDGE_ROUTES`）通过 `caused_by_event_id` 锚定的 attempt/review 事件——
 * 排除 FSRS-rating-derived 的散题复习 outcome 与手评 outcome（主观噪声不进 KT 画像）。
 */
async function readOutcomeSeq(db: Db, questionId: string): Promise<Array<0 | 1>> {
  const rows = await db
    .select({ outcome: event.outcome })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        inArray(event.action, ['review', 'attempt']),
        inArray(event.outcome, ['success', 'failure']),
        objectiveJudgeAnchorExists('event'),
      ),
    )
    .orderBy(asc(event.created_at));
  return rows.map((r) => (r.outcome === 'success' ? 1 : 0));
}

/**
 * 夜扫 KT 估计：候选预筛 → 逐题读序列 → estimateBkt → applyKtEstimate 落 kt_json。
 * 唯一写 = applyKtEstimate 的 kt_json sink（软轨低置信，零下游消费者，ADR-0035 决定 #4）。
 */
export async function runKtEstimateNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<KtEstimateNightlyResult> {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const result: KtEstimateNightlyResult = { considered: 0, estimated: 0, skipped_failed: 0 };

  // PRE-write read OUTSIDE any per-task swallow: a throw here is a legit retryable DB fault
  // (pg-boss retries). 候选 = 有硬轨 item_calibration 行 + question 非 draft + 有 ≥1 条**被客观
  // judge 事件锚定的**二元 attempt/review 事件。INNER JOIN item_calibration (track='hard') 保证
  // 硬轨行存在；JOIN question 排除 draft（G5）。EXISTS 子查询：内层 ev = 该题的 attempt/review
  // 事件（二元 outcome），外层 objectiveJudgeAnchorExists('ev') 保证它被一条 objective judge
  // 事件锚定（排除 FSRS-rating-derived / 手评 outcome——客观门，见文件头注释）。
  const candidates = await db
    .selectDistinct({ questionId: item_calibration.question_id })
    .from(item_calibration)
    .innerJoin(question, eq(question.id, item_calibration.question_id))
    .where(
      and(
        eq(item_calibration.track, 'hard'),
        // G5：draft_status IS DISTINCT FROM 'draft'（NULL 也算非 draft）。
        sql`${question.draft_status} IS DISTINCT FROM 'draft'`,
        // 有 ≥1 条**客观 judge 锚定的**二元作答事件（无客观锚序列 → 不该有 KT 画像，省开销）。
        sql`EXISTS (
          SELECT 1 FROM ${event} AS ev
          WHERE ev.subject_kind = 'question'
            AND ev.subject_id = ${item_calibration.question_id}
            AND ev.action IN ('review', 'attempt')
            AND ev.outcome IN ('success', 'failure')
            AND ${objectiveJudgeAnchorExists('ev')}
        )`,
      ),
    )
    .limit(maxPerRun);

  result.considered = candidates.length;
  if (candidates.length === 0) return result;

  for (const c of candidates) {
    try {
      // per-question 隔离（G1：job 顶层调，不在 attempt tx → 不加 SAVEPOINT）。
      const seq = await readOutcomeSeq(db, c.questionId);
      // prefilter 已保证非空，但防御：空序列只回吐先验，仍可落库（语义无害）；保留写以与
      // 「管线先就位」一致。estimateBkt 的输出是扁平 number 对象 = JsonObject。
      const estimate = estimateBkt(seq);
      await applyKtEstimate(db, {
        questionId: c.questionId,
        ktJson: estimate as unknown as Record<string, unknown>,
      });
      result.estimated++;
    } catch (err) {
      // 一道题的估计失败不该阻断其余题。logged + counted；下轮 job 再重试它（候选 SELECT
      // 仍命中——kt_json 整列覆盖，无半写）。
      console.error('[kt_estimate_nightly] question KT estimate failed', {
        questionId: c.questionId,
        err,
      });
      result.skipped_failed++;
    }
  }

  return result;
}

export function buildKtEstimateNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runKtEstimateNightly(db);
      console.log('[kt_estimate_nightly] result', result);
    } catch (err) {
      console.error('[kt_estimate_nightly] failed', err);
      throw err;
    }
  };
}
