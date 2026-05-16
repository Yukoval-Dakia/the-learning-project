import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { getCurriculum } from '@/subjects/wenyan/seed';
import { eq } from 'drizzle-orm';

export interface SeedResult {
  inserted: number;
  skipped: number;
}

/**
 * Idempotent seed runner: insert 顶级 wenyan knowledge nodes from curriculum.json.
 * Stable id `seed:<domain>:<slug>` so re-running 不会重复插入。
 *
 * 仅 PR A 范围：单 domain 'wenyan'，all-root nodes（parent_id=null），无层级。
 * 多层级 / 多 domain 留 Phase 2。
 */
export async function seedKnowledge(db: Db): Promise<SeedResult> {
  const curriculum = getCurriculum();
  let inserted = 0;
  let skipped = 0;

  for (const seed of curriculum.knowledge_seeds) {
    const id = `seed:${curriculum.domain}:${seed.slug}`;
    const existing = (
      await db.select({ id: knowledge.id }).from(knowledge).where(eq(knowledge.id, id)).limit(1)
    )[0];
    if (existing) {
      skipped += 1;
      continue;
    }
    const now = new Date();
    await db.insert(knowledge).values({
      id,
      name: seed.name,
      domain: curriculum.domain,
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    inserted += 1;
  }

  return { inserted, skipped };
}
