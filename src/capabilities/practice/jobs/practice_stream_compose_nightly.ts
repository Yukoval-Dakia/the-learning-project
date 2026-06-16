// YUK-361 Phase 4（Task 9）— hybrid 运行时夜间预产 job。
//
// ADR-0042 §4：运行时形态 = hybrid（夜间预产骨架 + 作答后增量重排）。本 job 是「夜间预产」
// 半边——每夜（用户晨起前）为「今天」预产练习流，省得用户首次打开练习面才 lazy compose（首读
// 不必等 LLM 编排器的网络往返）。增量重排半边在 stream-store.ts:reRankAfterAnswer（作答后）。
//
// **不分叉 compose 逻辑（DRY）**：本 job 调 stream-store.ts:composeNightly，而 composeNightly
// 复用与用户首读 lazy-compose **同一条** singleFlightCompose（单飞锁 + 双重检查 + policy 驱动的
// composeMaterializeCollect），唯一区别是物化行 `added_by='composer_nightly'`（区分夜链 AI 预产
// vs 用户首读懒产）。**不**走 legacy composeDailyStream——Phase 3 已把 softmax_mfi 设为默认
// policy（resolveSelectionPolicy）；夜间 job 与 live 读走同一条 policy 驱动路径。
//
// 幂等（双重检查 under lock，见 composeNightly docblock）：
//   - 夜间 job 跑两次 → 第二次命中「已物化 → no-op」。
//   - 夜间 job 跑完用户首读 → lazy-compose 命中同一双重检查 no-op（不 double-compose）。
//   - 用户先首读再夜间 job → 夜间 job 命中双重检查 no-op（不覆盖已产流）。
//
// 本地日（FINDING 4，Codex）：用 `streamLocalDate()`（**显式 Asia/Shanghai 时区**）——与读路径
// （api/stream.ts:resolveDate）**完全同款**（同一 helper），保证夜间预产的 date 键与用户首读
// lazy-compose 的 date 键一致（幂等前提：两条路径必须就「今天是哪天」达成一致，否则各产一份流）。
// cron 在 Asia/Shanghai tz 触发（manifest.ts: `'30 5 * * *', tz: 'Asia/Shanghai'`）；**修复前**
// 这里用进程本地时区，在 UTC 容器里 05:30 上海 = 前一日 21:30 UTC → 进程本地日是**前一天** →
// 给错误的日期预产流。现在显式锁定 Asia/Shanghai → cron tz 与「今天」对齐，读路径与夜间预产
// 共用 streamLocalDate() → 恒一致。
//
// 失败语义：composeNightly 内部走两级 fallback（永不 throw 出选题逻辑）；handler 顶层 try/catch
// 记日志后 rethrow → pg-boss 重试（DB 故障等可重试错误照常传播）。

import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { composeNightly, streamLocalDate } from '../server/stream-store';

export interface StreamComposeNightlyResult {
  /** 预产的本地日（YYYY-MM-DD）。 */
  date: string;
  /** 本轮新物化的行数（已物化 → 0，幂等 no-op）。 */
  added: number;
}

/**
 * 为「今天」预产练习流（hybrid 夜间预产）。幂等：今天已物化 → no-op（added=0）。
 */
export async function runStreamComposeNightly(db: Db): Promise<StreamComposeNightlyResult> {
  const date = streamLocalDate();
  const added = await composeNightly(db, date);
  return { date, added };
}

export function buildStreamComposeNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runStreamComposeNightly(db);
      console.log('[practice_stream_compose_nightly] result', result);
    } catch (err) {
      console.error('[practice_stream_compose_nightly] failed', err);
      throw err;
    }
  };
}
