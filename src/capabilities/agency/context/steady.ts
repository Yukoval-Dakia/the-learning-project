// 稳态段（B1）：读 memory brief 的 global scope 现成行，不生成、不改写 prose。
// 没有或用途非现行时如实缺省。`as_of` 高水位 = brief 覆盖到的最新证据时间。

import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { memory_brief_note } from '@/db/schema';
import { briefPurposeCurrent } from '@/kernel/read-models/purpose-change';
import type { SteadySection } from './types';

type DbLike = Db | Tx;

export async function readSteadySection(db: DbLike): Promise<SteadySection> {
  const [note] = await db
    .select()
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, 'global'))
    .limit(1);
  if (!note) return { portraitMd: null, asOf: null };
  const asOf = note.latest_evidence_at ?? note.refreshed_at ?? null;
  if (!(await briefPurposeCurrent(db, 'global', note.version))) {
    // 用途已被撤回且未按新用途重生成：稳态段如实缺省，高水位也不能用旧 prose 的。
    return { portraitMd: null, asOf: null };
  }
  const portrait = note.recent_week_md.trim();
  return { portraitMd: portrait.length > 0 ? portrait : null, asOf };
}
