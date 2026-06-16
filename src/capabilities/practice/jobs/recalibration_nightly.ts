// YUK-372 L1 (YUK-361 Phase 6 wire-up, ADR-0043 §4) — active-PPI 难度重标定的夜间触发器。
//
// recalibration.ts 的 recalibrateQuestion 是建好但**无生产 caller** 的离线 b 去偏引擎
// （Phase 6 刻意把触发器延后到估计器/π_i join 修对之后）。本 job 是那个触发器：每夜扫
// 「攒够标签 + 最近窗内有新标签」的题，逐题跑 recalibrateQuestion firm-up b_calib。
//
// 结构上仿 item_prior_backfill.ts：候选 SELECT（pre-write DB read，throw 冒泡 → pg-boss
// 重试）→ 逐题 await recalibrateQuestion，单题 throw 被 per-question try/catch 吞（不阻断
// 其余题）。recalibrateQuestion 在 job 顶层调用（NOT 嵌在任何 attempt tx 内），per-question
// try/catch 即足够隔离——**不**给 recalibrateQuestion 加 SAVEPOINT（G1：它不在 attempt tx 里）。
//
// ── 候选窗（open-Q 裁决）─────────────────────────────────────────────────────
// 候选 = 「该题历史标签 **总数** ≥ RECALIBRATION_MIN_LABELS」AND「question 非 draft」AND
//   「(A) 有标签在【昨日本地日起】窗内新建 OR (B) **stale 未校准**（calibration_n 落后于当前
//   标签总数，含从未校准 b_calib IS NULL / calibration_n=0）」。
//   - (A) 滚动窗用**昨日本地日起**（不是「今天」）：cron 跑在 04:50 Asia/Shanghai，「今天」本
//     地日才刚开始几乎无标签 → 用「今天」窗会几乎永远空（04:50-empty-today bug）。取昨日起
//     = 「自上次夜跑以来新攒的标签」，让昨天攒满的题今晨被重标定。
//   - (B) **stale 未校准并入扫描集**（Codex review F1 修复）：只看窗 (A) 会漏两类已够标签的题——
//     ① 首部署存量标签（攒够标签但 max(created_at) 早于昨天，b_calib 仍 NULL）；② cron 停机
//     >1 天后那些昨天前攒满、窗已滑过的题。两类都「永不进窗 → 永不校准」。stale 准入用
//     **calibration_n < 当前标签总数**（含从未校准的 calibration_n=0 / b_calib NULL）兜住它们：
//     标签数已 ≥ 阈值但折进 b_calib 的标签数落后 ⇒ 有未消费的标签 ⇒ 该重标定。
//   - **幂等**：已校准且 calibration_n == 当前标签总数 且无窗内新标签的题，(A)(B) 双 FALSE →
//     不入选，不重复跑（recalibrateQuestion 即便跑也是同输入同输出，但预筛省掉这次开销）。
//   - **历史总数**门（≥ threshold）只是预筛：真正的 firm-up 数据闸在 recalibrateQuestion 内
//     （labelCount < RECALIBRATION_MIN_LABELS → no-op）。预筛省掉对刚起步、永远不够阈值的题
//     反复跑 recalibrateQuestion 的开销。
//
// ── 红线 ────────────────────────────────────────────────────────────────────
// G1：recalibrateQuestion 在 job 顶层调，不在 attempt tx 内 → per-question try/catch 足够，
//     不加 SAVEPOINT。
// G5：候选 JOIN question WHERE draft_status IS DISTINCT FROM 'draft'（belt-and-suspenders；
//     draft 题不该被重标定锚）。
// G3：recalibrateQuestion 只写 b_calib（track='hard'）/ calibration_n / calibration_weight /
//     last_calibrated_at——never item b / stream / due。本 job 不新增任何写。

import type { Db } from '@/db/client';
import { difficulty_calibration_label, item_calibration, question } from '@/db/schema';
import {
  RECALIBRATION_MIN_LABELS,
  attemptLocalDate,
  recalibrateQuestion,
} from '@/server/mastery/recalibration';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

type DepsOverride = {
  /** 候选窗起点覆盖（测试注入固定 now；默认 new Date()）。 */
  now?: Date;
  /** 每轮最多重标定多少题（防一次 job 打爆）。default 200。 */
  maxPerRun?: number;
};

export interface RecalibrationNightlyResult {
  /** 本轮挑出的候选题数（capped by maxPerRun）。 */
  considered: number;
  /** 成功 firm-up b_calib 的题数（recalibrateQuestion updated=true）。 */
  recalibrated: number;
  /** 候选预筛过、但 recalibrateQuestion 内数据闸未过（labelCount < threshold）的题数。 */
  skipped_below: number;
  /** recalibrateQuestion 报 no_anchor（无 b_anchor 可校）的题数。 */
  skipped_no_anchor: number;
  /** 单题 recalibrateQuestion 抛错被跳过的题数（不阻断其余题）。 */
  skipped_failed: number;
}

const DEFAULT_MAX_PER_RUN = 200;

/**
 * 计算候选窗起点：**昨日本地日（Asia/Shanghai）零点对应的 UTC 时刻**。
 *
 * 取「昨天起」滚动窗——cron 04:50 Asia/Shanghai 跑时「今天」才刚开始几乎无标签，用昨日起
 * 才能捞到昨天攒满的题（avoid 04:50-empty-today bug）。实现：把 now 的本地日往前推一天，
 * 取那个本地日的 00:00 Asia/Shanghai。复用 attemptLocalDate（与标签 created_at 同度量时区）。
 */
function candidateWindowStart(now: Date): Date {
  // 昨天的本地日（YYYY-MM-DD，Asia/Shanghai）。
  const yesterdayLocal = attemptLocalDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  // 该本地日 00:00 Asia/Shanghai = `${date}T00:00:00+08:00`（CST 全年固定 +08:00，无 DST）。
  return new Date(`${yesterdayLocal}T00:00:00+08:00`);
}

/**
 * 夜扫重标定：候选预筛 → 逐题 recalibrateQuestion firm-up b_calib。零新写（除
 * recalibrateQuestion 内部的 b_calib firm-up）；只读消费标签 + 锚。
 */
export async function runRecalibrationNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<RecalibrationNightlyResult> {
  const now = deps.now ?? new Date();
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const result: RecalibrationNightlyResult = {
    considered: 0,
    recalibrated: 0,
    skipped_below: 0,
    skipped_no_anchor: 0,
    skipped_failed: 0,
  };

  const windowStart = candidateWindowStart(now);

  // PRE-write read OUTSIDE any per-task swallow: a throw here is a legit retryable DB fault
  // (pg-boss retries). 候选 = 历史标签总数 ≥ threshold + question 非 draft + (窗内新标签 OR stale
  // 未校准)。GROUP BY question_id，HAVING：
  //   (a) 总标签数 ≥ threshold（预筛），
  //   (b) 至少一条标签 created_at ≥ 窗起点（今晨有新进展），**OR**
  //   (c) stale 未校准：coalesce(max(calibration_n), 0) < 当前标签总数（折进 b_calib 的标签数落后
  //       于实际标签数 ⇒ 含从未校准 calibration_n=0 / 无 item_calibration row）OR b_calib 仍 NULL。
  // LEFT JOIN item_calibration (track='hard')：1:1（每题至多一条 hard 轨行），故 max()/bool_or()
  // 聚合是 GROUP-BY-safe 的恒等取值。JOIN question 排除 draft（G5）。
  // (c) 是 F1 修复：只看 (b) 窗会漏「攒够标签但 max(created_at) 早于昨天且未校准」的题（首部署
  // 存量标签 / cron 停机 >1 天），它们永不进窗 → 永不校准。stale 准入兜住它们；幂等由「已校准
  // 且 calibration_n == 标签总数」时 (b)(c) 双 FALSE 保证（不重复跑）。
  const candidates = await db
    .select({ questionId: difficulty_calibration_label.question_id })
    .from(difficulty_calibration_label)
    .innerJoin(question, eq(question.id, difficulty_calibration_label.question_id))
    .leftJoin(
      item_calibration,
      and(
        eq(item_calibration.question_id, difficulty_calibration_label.question_id),
        eq(item_calibration.track, 'hard'),
      ),
    )
    // G5：draft_status IS DISTINCT FROM 'draft'（NULL 也算非 draft）。
    .where(sql`${question.draft_status} IS DISTINCT FROM 'draft'`)
    .groupBy(difficulty_calibration_label.question_id)
    .having(
      and(
        gte(count(difficulty_calibration_label.id), RECALIBRATION_MIN_LABELS),
        // (b) 窗内新标签 OR (c) stale 未校准。窗起点显式 cast 成 timestamptz（postgres-js 在
        // HAVING 的 raw-sql 比较里推不出 Date 参数类型，故传 ISO 字符串 + ::timestamptz）。
        // calibration_n NOT NULL（DEFAULT 0），但 LEFT JOIN miss（无 hard 轨行）时 max() 为
        // NULL → coalesce 0 → < count ⇒ stale，正确把无锚但够标签的题纳入（recalibrateQuestion
        // 内会判 no_anchor 计 skipped_no_anchor，与窗内无锚题同语义）。bool_or(b_calib IS NULL)
        // 兜「外部写了 b_calib 却没同步 calibration_n」的防御性 stale。
        sql`(
          max(${difficulty_calibration_label.created_at}) >= ${windowStart.toISOString()}::timestamptz
          OR coalesce(max(${item_calibration.calibration_n}), 0) < count(${difficulty_calibration_label.id})
          OR bool_or(${item_calibration.b_calib} IS NULL)
        )`,
      ),
    )
    .limit(maxPerRun);

  result.considered = candidates.length;
  if (candidates.length === 0) return result;

  for (const c of candidates) {
    try {
      // recalibrateQuestion 在 job 顶层调（NOT 嵌在 attempt tx）→ per-question try/catch 足够
      // 隔离（G1：不加 SAVEPOINT）。它只写 b_calib 轨（G3：never item b / stream / due）。
      const r = await recalibrateQuestion(db, c.questionId);
      if (r.updated) {
        result.recalibrated++;
      } else if (r.reason === 'no_anchor') {
        result.skipped_no_anchor++;
      } else {
        // below_threshold（候选预筛用历史总数，但 recalibrateQuestion 内闸是同一阈值——
        // 预筛 ≥ threshold 的题正常会过内闸；这分支兜并发删标签等竞态）。
        result.skipped_below++;
      }
    } catch (err) {
      // 一道题的重标定失败不该阻断其余题。logged + counted；下轮 job 再重试它（候选 SELECT
      // 仍命中——没写成 b_calib）。
      console.error('[recalibration_nightly] question recalibration failed', {
        questionId: c.questionId,
        err,
      });
      result.skipped_failed++;
    }
  }

  return result;
}

export function buildRecalibrationNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runRecalibrationNightly(db);
      console.log('[recalibration_nightly] result', result);
    } catch (err) {
      console.error('[recalibration_nightly] failed', err);
      throw err;
    }
  };
}
