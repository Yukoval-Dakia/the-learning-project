// YUK-372 L3 — family_key 解析的单一真相源（从 personalized-difficulty.ts 的内联派生提炼）。
//
// family_key = `${subject}:${primaryKnowledgeId}:${kind}:${source}`（见 personalized-difficulty
// familyKey）。subject 是**派生轴**（不是存储列）：primaryKnowledgeId 的 effective domain →
// resolveKnownSubjectId。orphan / 未知 domain → 'unknown' 段（绝不塌进 default profile，防过匹配）。
//
// 这层把 recordFamilyObservationForAttempt（写侧）与 candidate-signals / state（读侧）共用同一
// 解析逻辑——避免读写两侧各自内联一份 subject 派生而漂移。format 不变（仍是 familyKey 的串）。
//
// G1（NO-OP-safe foundation 的护栏）：getEffectiveDomain 对 orphan id 抛错——本模块**必须**
// try/catch 兜成 'unknown'，让 subject 派生永不 crash 调用方（state.ts updateThetaForAttempt
// 主路径绝不能因 subject 解析失败而 abort θ̂）。

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { isNull } from 'drizzle-orm';

type DbLike = Db | Tx;

// family_key 串格式（与 personalized-difficulty.ts familyKey 同步——**不**从那里 import 以避免
// family-key.ts ↔ personalized-difficulty.ts 循环依赖；格式是单行四段 join，此处内联是唯一例外，
// personalized-difficulty.familyKey 改格式时这里必须同改）。
function buildFamilyKey(
  subject: string,
  primaryKnowledgeId: string,
  kind: string,
  source: string,
): string {
  return `${subject}:${primaryKnowledgeId}:${kind}:${source}`;
}

export interface FamilyKeyInput {
  /** 题目的主 knowledge_id（q.knowledge_ids[0]）。空 → 无法成键 → null。 */
  primaryKnowledgeId: string | null | undefined;
  /** question.kind。 */
  kind: string | null | undefined;
  /** question.source。 */
  source: string | null | undefined;
}

/**
 * 解析单题的 family_key，或 null（无 primaryKnowledgeId / kind / source 任一缺失 → 无法成键）。
 * subject 经 getEffectiveDomain → resolveKnownSubjectId 派生，orphan/未知 → 'unknown'（never
 * crash，never 塌 default）。
 */
export async function resolveFamilyKeyForQuestion(
  db: DbLike,
  input: FamilyKeyInput,
): Promise<string | null> {
  const primaryKnowledgeId = input.primaryKnowledgeId?.trim();
  if (!primaryKnowledgeId || !input.kind || !input.source) return null;

  // G1：getEffectiveDomain 对 orphan id 抛错 → try/catch 兜 'unknown'，subject 派生绝不 crash。
  let subject = 'unknown';
  try {
    const domain = await getEffectiveDomain(db, primaryKnowledgeId);
    subject = resolveKnownSubjectId(domain) ?? 'unknown';
  } catch {
    subject = 'unknown';
  }

  return buildFamilyKey(subject, primaryKnowledgeId, input.kind, input.source);
}

/**
 * 批量解析多题的 family_key → Map<questionId, family_key|null>。一次性加载活跃 knowledge 树做
 * **内存** effective-domain walk（不是 per-candidate 的 32-climb DB 往返），subject 派生单遍。
 *
 * orphan / 未知 domain → 'unknown'（同单题路径）。任一 kind/source/primaryKnowledgeId 缺失 → null。
 */
export async function batchResolveFamilyKeys(
  db: DbLike,
  items: Array<{ questionId: string } & FamilyKeyInput>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (items.length === 0) return out;

  // 一次加载活跃 knowledge 树（单用户，数百节点），内存里 climb effective domain（mirror
  // resolveSubjectKnowledgeIds 的 in-memory walk——archived 祖先已不在 byId → walk 停在它，
  // 与 archived-ancestor cutoff 一致）。
  const rows = await db
    .select({
      id: knowledge.id,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const effectiveDomain = (id: string): string | null => {
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.domain) return current.domain;
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return null;
  };

  // 缓存 primaryKnowledgeId → subject（同一 KC 多题共享）。
  const subjectByKid = new Map<string, string>();

  for (const item of items) {
    const primaryKnowledgeId = item.primaryKnowledgeId?.trim();
    if (!primaryKnowledgeId || !item.kind || !item.source) {
      out.set(item.questionId, null);
      continue;
    }
    let subject = subjectByKid.get(primaryKnowledgeId);
    if (subject === undefined) {
      // 内存 walk；archived/orphan（不在 byId）→ effectiveDomain 返 null → 'unknown'。
      const domain = effectiveDomain(primaryKnowledgeId);
      subject = resolveKnownSubjectId(domain) ?? 'unknown';
      subjectByKid.set(primaryKnowledgeId, subject);
    }
    out.set(item.questionId, buildFamilyKey(subject, primaryKnowledgeId, item.kind, item.source));
  }

  return out;
}
