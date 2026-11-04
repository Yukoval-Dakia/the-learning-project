// 稳态段（B1）：读 memory brief 的 global scope 现成行（经 context/memory-brief
// 的唯一读口径），不生成、不改写 prose；没有或用途非现行时如实缺省。
// `as_of` 高水位 = 最近一次成功 Dreaming 固化（experimental:dreaming_scan
// outcome='success'）的 created_at —— brief 再生成随事件扇出（≤6 分钟单例），
// 其证据时间会追平新作答，不能当固化水位。没有过 Dreaming 时退回固定回看窗，
// 由 asOfBasis 如实区分。

import { and, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { readMemoryBriefNote } from './memory-brief';
import type { SteadySection } from './types';

type DbLike = Db | Tx;

const DREAMING_SCAN_ACTION = 'experimental:dreaming_scan';

/** 无 Dreaming 固化记录时 Δ 段的回看窗（companion 渲染按天如实标注）。 */
export const DELTA_FALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

async function lastDreamingConsolidationAt(db: DbLike): Promise<Date | null> {
  const [row] = await db
    .select({ max_at: sql<Date | null>`max(${event.created_at})` })
    .from(event)
    .where(and(eq(event.action, DREAMING_SCAN_ACTION), eq(event.outcome, 'success')));
  return row?.max_at ? new Date(row.max_at) : null;
}

export async function readSteadySection(db: DbLike, opts: { now: Date }): Promise<SteadySection> {
  const [brief, dreamingAt] = await Promise.all([
    readMemoryBriefNote(db, 'global', opts.now),
    lastDreamingConsolidationAt(db),
  ]);
  const portrait = brief.note?.recent_week_md.trim() ?? '';
  return {
    portraitMd: portrait.length > 0 ? portrait : null,
    asOf: dreamingAt ?? new Date(opts.now.getTime() - DELTA_FALLBACK_LOOKBACK_MS),
    asOfBasis: dreamingAt ? 'dreaming' : 'lookback',
  };
}
