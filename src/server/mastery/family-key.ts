// YUK-372 L3 — family_key 解析的单一真相源（从 personalized-difficulty.ts 的内联派生提炼）。
//
// family_key = `${subject}:${primaryKnowledgeId}:${kind}:${source}`（见 personalized-difficulty
// familyKey）。subject 是**派生轴**（不是存储列）：primaryKnowledgeId 的 effective domain →
// resolveKnownSubjectId。orphan / 未知 domain → 'unknown' 段（绝不塌进 default profile，防过匹配）。
//
// 这层把 recordFamilyObservationForAttempt（写侧）与 candidate-signals / state（读侧）共用同一
// 解析逻辑——避免读写两侧各自内联一份 subject 派生而漂移。format 不变（仍是 familyKey 的串）。
//
// 单一真相源对齐的是 **getEffectiveDomain**（archived-INCLUSIVE：按 id 点查、爬过 archived 祖先
// 取其 domain），不是 resolveSubjectKnowledgeIds（archived-cutoff，walk 停在 archived 祖先）。
// family_key 必须在「写/θ̂ 单题路径」（resolveFamilyKeyForQuestion → getEffectiveDomain）与
// 「candidate-signals 批量选题路径」（batchResolveFamilyKeys 内存 walk）两侧对 archived 祖先
// 收敛到同一键，否则「有效 domain 经 archived 中间祖先解析」的 KC 会写侧 = `<subject>:...`、
// 读侧 = `unknown:...`，effectiveFamilyB 在选题侧静默 NO-OP（YUK-372 read/write 键漂移修复）。
// 因此批量 walk **加载全树（不过滤 archived_at）**，让 in-memory climb 能走进 archived 祖先，
// 与 getEffectiveDomain 的 archived-inclusive 语义一致。
//
// G1（NO-OP-safe foundation 的护栏）：getEffectiveDomain 对 orphan id 抛错——本模块**必须**
// try/catch 兜成 'unknown'，让 subject 派生永不 crash 调用方（state.ts updateThetaForAttempt
// 主路径绝不能因 subject 解析失败而 abort θ̂）。

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { buildFamilyKey } from './family-key-format';

type DbLike = Db | Tx;

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

  // 一次加载**全**knowledge 树（单用户，数百节点；**不**过滤 archived_at），内存里 climb
  // effective domain。关键：与写/θ̂ 单题路径的 getEffectiveDomain（archived-INCLUSIVE，点查爬过
  // archived 祖先）同语义——若此处沿用 resolveSubjectKnowledgeIds 的 archived-cutoff（停在
  // archived 祖先），则「有效 domain 来自 archived 中间祖先」的 KC 在选题侧解析成 'unknown' 段、
  // 与写侧 `<subject>:...` 键不匹配 → familyRow=null → effectiveFamilyB 静默 NO-OP（YUK-372 修复）。
  const rows = await db
    .select({
      id: knowledge.id,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
    })
    .from(knowledge);
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
      // 内存 walk（archived-inclusive：archived 祖先在 byId 内，walk 不在其处截断，与
      // getEffectiveDomain 一致）；真 orphan（id 完全不在树里）→ null → 'unknown'。
      const domain = effectiveDomain(primaryKnowledgeId);
      subject = resolveKnownSubjectId(domain) ?? 'unknown';
      subjectByKid.set(primaryKnowledgeId, subject);
    }
    out.set(item.questionId, buildFamilyKey(subject, primaryKnowledgeId, item.kind, item.source));
  }

  return out;
}
