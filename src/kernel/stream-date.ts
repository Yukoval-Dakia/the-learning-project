/**
 * 用户本地日历日（YYYY-MM-DD），**显式锁定 Asia/Shanghai 时区**——「今天的练习流」的唯一
 * 真相源。
 *
 * 为什么不能用进程本地时区（`toLocaleDateString('sv-SE')` 无 timeZone 选项）：
 * - 夜间预产 cron 在 **Asia/Shanghai** 触发（manifest.ts: `'30 5 * * *', tz: 'Asia/Shanghai'`）。
 * 在 **UTC 容器**里（NAS/prod 默认），05:30 上海 = 前一日 21:30 UTC → 进程本地日是**前一天**
 * → 夜间 job 给**错误的日期**预产流。
 * - 读路径（api/stream.ts:resolveDate 的「today」）也要用同一时区，否则夜间产 date-A、用户
 * 首读 lazy-compose 算出 date-B → 各产一份流（double-compose / 互不命中双重检查）。
 *
 * 单用户工具，用户时区固定 Asia/Shanghai；与既有 SQL 侧 `now at time zone 'Asia/Shanghai'`
 * （workbench-summary.ts）+ 所有夜链 cron 的 `tz: 'Asia/Shanghai'` 一致。读路径与夜间预产**都**
 * 走本 helper → 两条路径对「今天是哪天」恒一致（幂等前提）。
 */
import { getConfig } from '@/core/config/store';
import { loadLearnerActivityStreakStart } from '@/kernel/read-models/learner-activity';

export function streamLocalDate(now: Date = new Date()): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/**
 * 「今天的练习流」的学习日裁定（YUK-2125）。
 *
 * 学习日 ≠ 日历日：日历日按 Asia/Shanghai 零点硬切会让深夜连续作答过零点后
 * 「今天」换成空分区——前一日 pending/in_progress 被留在旧分区、用户还要再付
 * 一次 lazy compose。改为按**学习者真实练习活动**的不活跃间隔切：
 *
 * - `loadLearnerActivityStreakStart` 只看 `actor_kind='user'` 且属
 *   `LEARNING_ACTIVITY_ACTIONS` 的事件（后台 job / 系统写入不算活动），并把
 *   从 `now` 往回、相邻间隔都小于 `gapMs` 的连续活动段找出来。
 * - 段还在延续（最近一次活动距 `now` < gap）→ 「今天」= 段首日所在的日历日。
 *   23:50 开始、00:10 刷新：段首日仍是前一日 → 同一 date 分区，无新 compose。
 * - 段已关闭（最近一次活动距 `now` ≥ gap 或从无活动）→ 「今天」= 当前日历日：
 *   真正的新学习日，旧分区 pending/in_progress 由流层带进新一天的生成。
 *
 * 读路径（api/start 的 `date=today`）与夜间预产 job 必须走同一个裁定才能共享
 * 幂等键；显式 `?date=YYYY-MM-DD` 的历史读取不走本函数（保留原日历日语义）。
 */
export async function resolveLearningDayDate(
  db: Parameters<typeof loadLearnerActivityStreakStart>[0],
  now: Date = new Date(),
  gapMs: number = defaultLearningDayInactivityGapMs(),
): Promise<string> {
  const streakStart = await loadLearnerActivityStreakStart(db, gapMs, now);
  if (streakStart === null) return streamLocalDate(now);
  return streamLocalDate(streakStart);
}

/** 默认不活跃间隔：读热配置，缺失/异常时回落 4 小时。 */
function defaultLearningDayInactivityGapMs(): number {
  const hours = getConfig('LEARNING_DAY_INACTIVITY_GAP_HOURS');
  return (typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : 4) * 3_600_000;
}
