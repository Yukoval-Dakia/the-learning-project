import type { D1Database } from '@cloudflare/workers-types';
import { getCurriculum } from '../../../src/subjects/wenyan/seed';

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
export async function seedKnowledge(db: D1Database): Promise<SeedResult> {
  const curriculum = getCurriculum();
  let inserted = 0;
  let skipped = 0;

  for (const seed of curriculum.knowledge_seeds) {
    const id = `seed:${curriculum.domain}:${seed.slug}`;
    const existing = await db
      .prepare('select id from knowledge where id = ?')
      .bind(id)
      .first<{ id: string }>();
    if (existing) {
      skipped += 1;
      continue;
    }
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        `insert into knowledge (
          id, name, domain, parent_id, base_mastery, ai_delta_mastery,
          merged_from, proposed_by_ai, approval_status, created_at, updated_at, version
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, seed.name, curriculum.domain, null, 0, 0, '[]', 0, 'approved', now, now, 0)
      .run();
    inserted += 1;
  }

  return { inserted, skipped };
}
