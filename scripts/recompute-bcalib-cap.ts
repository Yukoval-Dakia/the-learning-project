// YUK-558 (worklist #7, spec docs/design/2026-07-03-softmax-spec.md §1.4 / Q2-d / Q-g) —
// 一次性追溯 recompute：cap ship 后对已 firm-up 的存量题重跑 recalibrateQuestion，把 median-相对
// IPW 截权追溯应用到既存的 b_calib。
//
// WHY. 夜跑候选 SELECT（recalibration_nightly.ts HAVING）在 firm-up 后（calibration_n == count
// 且 b_calib 非 NULL）**不再重选该题**——被旧（uncapped）估计器冻结的 b_calib 不会自动重算。
// 未截权时连重算也不自愈（fluke 以存量 π 在每次全量重算里保持 ~99% 质量）。cap ship 后必须
// 对存量 `b_calib IS NOT NULL` 的题跑一遍全量重算（recalibrateQuestion 同输入 ⇒ 纯 re-run ⇒
// 幂等），把 cap 的 bias-for-variance 收益追溯到已污染的存量值。
//
// IDEMPOTENT — 值幂等 vs 写幂等分开陈述（C5，诚实化）：
//   - **值幂等**：recalibrateQuestion 是确定性的全量重算（每次跑都从该题的全部
//     difficulty_calibration_label 重新算 b_calib）——**同标签集 ⇒ 同 b_calib**。重跑此脚本对
//     已 cap 过的题 b_calib 不变（值层面 no-op）。
//   - **写非幂等**：即便 b_calib 值不变，recalibrateQuestion 每跑仍**无条件刷新**
//     last_calibrated_at / updated_at（`new Date()`）——重跑会推进这两个时间戳。故「幂等」限于
//     **值**，不含审计时间戳；重跑不是零副作用（对下游按 updated_at 的观测/缓存有影响）。
//   每题独立 try/catch（per-question 失败不阻断其余，同夜跑 job）。
//
// SCOPE. 仅 `item_calibration WHERE track='hard' AND b_calib IS NOT NULL`——只重算**已 firm-up**
// 的存量；未 firm-up（b_calib NULL）的题由夜跑 job 按常规窗/stale 准入处理（不在本脚本 scope）。
// 若存量 `b_calib IS NOT NULL` 行为零 ⇒ considered=0 ⇒ 天然 no-op（spec §5 PR-1 可选步骤终止条件）。
//
// BEHAVIOR-PRESERVING: 一次性 maintenance 脚本，**不**接入任何 live 请求路径；不新增写面
// （只调既有 recalibrateQuestion，它写 b_calib/calibration_n/calibration_weight/last_calibrated_at，
// 都是既有写路径）。owner 在 cap ship 后手动跑一次即可。
//
// CLI:
//   pnpm db:recompute:bcalib   # 一次性追溯重算存量 b_calib（幂等）

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { db } from '@/db/client';
import type { Db } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { recalibrateQuestion } from '@/server/mastery/recalibration';
import { and, eq, isNotNull } from 'drizzle-orm';

export interface RecomputeBCalibCapResult {
  /** 候选题数（b_calib IS NOT NULL 的 hard 轨行）。 */
  considered: number;
  /** 成功重算（recalibrateQuestion updated=true）的题数。 */
  recalibrated: number;
  /** 单题 recalibrateQuestion 抛错被跳过的题数（不阻断其余）。 */
  skipped_failed: number;
  /**
   * recalibrateQuestion 返回 updated=false 但**未抛错**（no_anchor / below_threshold）的题数
   * （YUK-558 bot 轮补——先前这类题既不进 recalibrated 也不进 skipped_failed，operator 无视野）。
   * 恒等式在 docblock 声明：considered === recalibrated + skipped_failed + skipped_not_updated
   * （每题恰落一桶）。reason 细分见 skipped_by_reason。
   */
  skipped_not_updated: number;
  /** skipped_not_updated 的 reason 细分（'no_anchor' / 'below_threshold' / …）——operator 诊断。 */
  skipped_by_reason: Record<string, number>;
  /** 本轮重算题上 median-相对 IPW 截权的总激活条数（YUK-558 M1 clip 可观测）。 */
  clip_activations: number;
  /** 本轮重算批里见过的最小 inclusion probability（fat-tail 深度极值）；无 → null。 */
  min_pi_seen: number | null;
  /** 本轮重算批里见过的最大 inclusion probability（min-max π 观测面，spec M1）；无 → null。 */
  max_pi_seen: number | null;
}

/**
 * 一次性追溯重算：对所有 `b_calib IS NOT NULL` 的 hard 轨题重跑 recalibrateQuestion（幂等全量重算），
 * 把 median-相对 IPW 截权（YUK-558 M1）追溯应用到存量 b_calib。
 *
 * Pipeline fn 导出以便 owner/未来测试驱动；main() 仅在 CLI 入口时触发，import 本模块无副作用
 * （同 backfill-genesis-events.ts 惯例）。
 */
export async function runRecomputeBCalibCap(db: Db): Promise<RecomputeBCalibCapResult> {
  // 候选 = track='hard' AND b_calib IS NOT NULL（spec §1.4：夜跑 stale 条件不会自动触发它们，
  // 故需本一次性 pass）。PRE-write read：throw 冒泡到 CLI 顶层 try/catch（本脚本不在 job 队列里，
  // 是 owner 手动一次性运行）。
  const rows = await db
    .select({ question_id: item_calibration.question_id })
    .from(item_calibration)
    .where(and(eq(item_calibration.track, 'hard'), isNotNull(item_calibration.b_calib)));

  const result: RecomputeBCalibCapResult = {
    considered: rows.length,
    recalibrated: 0,
    skipped_failed: 0,
    skipped_not_updated: 0,
    skipped_by_reason: {},
    clip_activations: 0,
    min_pi_seen: null,
    max_pi_seen: null,
  };

  if (rows.length === 0) return result;

  for (const r of rows) {
    try {
      // recalibrateQuestion 是确定性的全量重算（从该题全部 label 重新算 b_calib）——
      // 同标签集 ⇒ 同输出 ⇒ 幂等。per-question try/catch（同夜跑 job 隔离纪律）。
      const res = await recalibrateQuestion(db, r.question_id);
      if (res.updated) {
        result.recalibrated++;
        // Clip 可观测聚合（YUK-558 M1）：累加截权激活数 + 追踪最小/最大 π（fat-tail 深度极值 + min-max π 面）。
        result.clip_activations += res.clipActivations;
        if (res.minPi !== null) {
          result.min_pi_seen =
            result.min_pi_seen === null ? res.minPi : Math.min(result.min_pi_seen, res.minPi);
        }
        if (res.maxPi !== null) {
          result.max_pi_seen =
            result.max_pi_seen === null ? res.maxPi : Math.max(result.max_pi_seen, res.maxPi);
        }
      } else {
        // updated=false 无异常（no_anchor / below_threshold，如 b_calib 存量非空但锚缺失/标签跌破阈值）——
        // 单计数 + reason 分桶（YUK-558 bot 轮补 operator 视野，闭合
        // considered === recalibrated + skipped_failed + skipped_not_updated 恒等）。
        result.skipped_not_updated++;
        const reason = res.reason ?? 'unknown';
        result.skipped_by_reason[reason] = (result.skipped_by_reason[reason] ?? 0) + 1;
      }
    } catch (err) {
      // 单题失败不阻断其余（per-question 隔离，同 recalibration_nightly job）。
      console.error('[recompute-bcalib-cap] question recompute failed', {
        questionId: r.question_id,
        err,
      });
      result.skipped_failed++;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const result = await runRecomputeBCalibCap(db);
  console.log('[recompute-bcalib-cap] result', result);
}

// CLI-gate: only run + exit as the CLI entry point so importing this module is side-effect-free
// (mirror rebuild-projection.ts / backfill-genesis-events.ts).
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('recompute-bcalib-cap.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[recompute-bcalib-cap] failed:', err);
      process.exit(1);
    });
}
