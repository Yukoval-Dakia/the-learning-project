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
// IDEMPOTENT (single-run). recalibrateQuestion 是确定性的全量重算（每次跑都从该题的全部
// difficulty_calibration_label 重新算 b_calib）——同标签集 ⇒ 同输出。重跑此脚本对已 cap 过的
// 题是 no-op（b_calib 不变）。每题独立 try/catch（per-question 失败不阻断其余，同夜跑 job）。
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
import { and, eq, isNotNull } from 'drizzle-orm';
import { recalibrateQuestion } from '../src/server/mastery/recalibration';

export interface RecomputeBCalibCapResult {
  /** 候选题数（b_calib IS NOT NULL 的 hard 轨行）。 */
  considered: number;
  /** 成功重算（recalibrateQuestion updated=true）的题数。 */
  recalibrated: number;
  /** 单题 recalibrateQuestion 抛错被跳过的题数（不阻断其余）。 */
  skipped_failed: number;
  /** 本轮重算题上 median-相对 IPW 截权的总激活条数（YUK-558 M1 clip 可观测）。 */
  clip_activations: number;
  /** 本轮重算批里见过的最小 inclusion probability（fat-tail 深度极值）；无 → null。 */
  min_pi_seen: number | null;
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
    clip_activations: 0,
    min_pi_seen: null,
  };

  if (rows.length === 0) return result;

  for (const r of rows) {
    try {
      // recalibrateQuestion 是确定性的全量重算（从该题全部 label 重新算 b_calib）——
      // 同标签集 ⇒ 同输出 ⇒ 幂等。per-question try/catch（同夜跑 job 隔离纪律）。
      const res = await recalibrateQuestion(db, r.question_id);
      if (res.updated) {
        result.recalibrated++;
        // Clip 可观测聚合（YUK-558 M1）：累加截权激活数 + 追踪最小 π。
        result.clip_activations += res.clipActivations;
        if (res.minPi !== null) {
          result.min_pi_seen =
            result.min_pi_seen === null ? res.minPi : Math.min(result.min_pi_seen, res.minPi);
        }
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
