// Memory brief 读语义的唯一实现（YUK-1794 B1 收口）：scope 行 + 用途现行闸 +
// freshness 一处算。agency 是本语义的 owner；非 agency 消费方经 kernel 端口
// `read-models/memory-brief`（installAgencyHostOperations 启动时绑定）。

import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { memory_brief_note } from '@/db/schema';
import type { MemoryBriefRead } from '@/kernel/read-models/memory-brief';
import { briefPurposeCurrent } from '@/kernel/read-models/purpose-change';

type DbLike = Db | Tx;

export const MEMORY_BRIEF_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function readMemoryBriefNote(
  db: DbLike,
  scopeKey: string,
  now: Date = new Date(),
): Promise<MemoryBriefRead> {
  const [note] = await db
    .select()
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, scopeKey))
    .limit(1);
  if (!note || !(await briefPurposeCurrent(db, scopeKey, note.version))) {
    // 用途已被撤回且未按新用途重生成：与无行同样如实缺省。
    return {
      note: null,
      freshness: {
        state: 'missing',
        age_ms: null,
        stale_after_ms: MEMORY_BRIEF_STALE_AFTER_MS,
      },
    };
  }
  const ageMs = note.refreshed_at ? Math.max(0, now.getTime() - note.refreshed_at.getTime()) : null;
  return {
    note: {
      id: note.id,
      scope_key: note.scope_key,
      subject_id: note.subject_id ?? null,
      recent_week_md: note.recent_week_md,
      recent_months_md: note.recent_months_md,
      long_term_md: note.long_term_md,
      long_term_freshness_score: note.long_term_freshness_score ?? null,
      refreshed_at: note.refreshed_at ?? null,
      source_event_id: note.source_event_id ?? null,
      version: note.version,
      recent_week_evidence_ids: note.recent_week_evidence_ids,
      recent_months_evidence_ids: note.recent_months_evidence_ids,
      long_term_evidence_ids: note.long_term_evidence_ids,
    },
    freshness: {
      // A previous-night or never-refreshed brief must not read as current context.
      state: ageMs === null || ageMs >= MEMORY_BRIEF_STALE_AFTER_MS ? 'stale' : 'fresh',
      age_ms: ageMs,
      stale_after_ms: MEMORY_BRIEF_STALE_AFTER_MS,
    },
  };
}
