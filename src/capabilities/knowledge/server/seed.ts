import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { KNOWN_SUBJECT_IDS, subjectProfiles } from '@/subjects/profile';
import { eq } from 'drizzle-orm';

export interface SeedResult {
  inserted: number;
  skipped: number;
}

/**
 * 冷启 day-one 薄 seed（YUK-477）：**只放科目节点**——每个已知科目一个 domain-root 节点。
 *
 * 作用（owner 2026-06-21 内容模型）：让 fresh DB 的知识树非空，给用户上传抽出的子 KC 一个
 * 挂靠锚（上传子 KC 挂科目节点下、经父链继承 domain），并让 goal scope / placement 有 KC 可指。
 * **不放 curriculum 子树**——子 KC 留给用户上传有机生长（YUK-478）/ 后续动态供题 refill（YUK-474）。
 *
 * 驱动源 = subject profile 注册表的 `KNOWN_SUBJECT_IDS`（wenyan/math/physics；`general` 是
 * fallback identity、永不作 node domain，故不在此列——见 subjects/profile.ts）。各科平铺一个根
 * 节点，不以任一科为主角。
 *
 * 树一致性（不违反 subject=view）：节点 `domain=<subjectId>` 让 `resolveKnownSubjectId(domain)
 * === subjectId`（自别名），subject 仍经 effective-domain 派生，不给实体加 subject 列。
 *
 * 幂等：稳定 id `seed:<subjectId>:root`，重跑 skip（migrate/bootstrap 链路可每次启动安全调用）。
 */
export async function seedKnowledge(db: Db): Promise<SeedResult> {
  let inserted = 0;
  let skipped = 0;

  for (const subjectId of KNOWN_SUBJECT_IDS) {
    const id = `seed:${subjectId}:root`;
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
      // displayName 是科目的人读名（profile 必有，schema min(1)）；理论兜底 subjectId。
      name: subjectProfiles[subjectId]?.displayName ?? subjectId,
      // domain = subjectId：self-alias 使 resolveKnownSubjectId(domain)===subjectId，
      // 上传子 KC 经父链继承此 domain（effective-domain 派生轴）。
      domain: subjectId,
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
