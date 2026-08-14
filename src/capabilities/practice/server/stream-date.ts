/**
 * 用户本地日历日（YYYY-MM-DD），**显式锁定 Asia/Shanghai 时区**——「今天的练习流」的唯一
 * 真相源（FINDING 4，Codex）。
 *
 * 为什么不能用进程本地时区（`toLocaleDateString('sv-SE')` 无 timeZone 选项）：
 *   - 夜间预产 cron 在 **Asia/Shanghai** 触发（manifest.ts: `'30 5 * * *', tz: 'Asia/Shanghai'`）。
 *     在 **UTC 容器**里（NAS/prod 默认），05:30 上海 = 前一日 21:30 UTC → 进程本地日是**前一天**
 *     → 夜间 job 给**错误的日期**预产流。
 *   - 读路径（api/stream.ts:resolveDate 的「today」）也要用同一时区，否则夜间产 date-A、用户
 *     首读 lazy-compose 算出 date-B → 各产一份流（double-compose / 互不命中双重检查）。
 *
 * 单用户工具，用户时区固定 Asia/Shanghai；与既有 SQL 侧 `now() at time zone 'Asia/Shanghai'`
 * （workbench-summary.ts）+ 所有夜链 cron 的 `tz: 'Asia/Shanghai'` 一致。读路径与夜间预产**都**
 * 走本 helper → 两条路径对「今天是哪天」恒一致（幂等前提）。
 */
export function streamLocalDate(now: Date = new Date()): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}
