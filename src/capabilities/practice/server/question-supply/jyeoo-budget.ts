// YUK-986 (Supply-Agent/1) — jyeoo loom 侧日预算租约（事件溯源）。
//
// jyeoo-rs 内容拉题是付费账号资源：producer 自带 --daily-max 40（Asia/Shanghai 自然日，
// 硬闸，记录于账号 .usage.json）。本模块是 loom 侧的 PRE-FLIGHT 预算读：让 tool/agent 在
// 烧一次完整抓取前知道还剩多少，并把 session_max 裁到余额内。硬闸仍在 producer（双闸语义
// 与 DESIGN §10 谨慎档一致）——loom 侧读数允许与 producer 微小漂移（例如 loom 过滤掉的行
// producer 也计数），不影响正确性。
//
// 事件溯源：fetch 核（runJyeooFetchCandidates，YUK-988 E3 起核内单写）每次成功运行写
// action='experimental:jyeoo_fetch' outcome='success' 事件（payload.counts.fetched =
// producer 实际产出题数）。预算余额 = 当日（Asia/Shanghai）已 fetched 总和 vs 日预算。
// 无独立表（避免为计数器做迁移）；并发超取窗口由 producer 硬闸兜底，文档化接受。

import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';

export const JYEOO_FETCH_CANARY_ACTION = 'experimental:jyeoo_fetch';

/** 日预算（Asia/Shanghai 自然日）。默认 40 = producer 谨慎档；env 可调低做更保守的 loom 侧闸（0 = 当日禁抓，operator kill-switch）。 */
export function jyeooDailyFetchBudget(): number {
  const raw = process.env.JYEOO_DAILY_FETCH_BUDGET;
  if (!raw) return 40;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 40;
}

/** Asia/Shanghai（UTC+8，无 DST）当日 00:00 的 UTC 时刻。producer 预算文件同此自然日口径。 */
export function shanghaiDayStart(now: Date): Date {
  const OFFSET_MS = 8 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Math.floor((now.getTime() + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS);
}

/** 当日已 fetched 总量（成功 canary 事件的 counts.fetched 求和）。 */
export async function jyeooFetchedToday(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db.execute<{ fetched: number | null }>(sql`
    select coalesce(sum((payload->'counts'->>'fetched')::int), 0) as fetched
    from ${event}
    where ${event.action} = ${JYEOO_FETCH_CANARY_ACTION}
      and ${event.outcome} = 'success'
      and ${event.created_at} >= ${shanghaiDayStart(now).toISOString()}
  `);
  const row = (rows as unknown as Array<{ fetched: number | string | null }>)[0];
  const value = row?.fetched;
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : (value ?? 0);
  return Number.isFinite(n) ? Number(n) : 0;
}

/** 剩余额度；0 = 当日预算已尽（fetch tool 应以 budget_exhausted 短路）。 */
export async function jyeooBudgetRemaining(db: Db, now: Date = new Date()): Promise<number> {
  const used = await jyeooFetchedToday(db, now);
  return Math.max(0, jyeooDailyFetchBudget() - used);
}
