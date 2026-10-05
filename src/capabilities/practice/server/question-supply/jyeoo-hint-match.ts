// YUK-986 (Supply-Agent/1) — jyeoo knowledge_hints → 知识树确定性名匹配。
//
// producer meta.knowledge_hints 形态（0.2.0 grade 路线实测）：第一项是知识点名
// （如「几何概型」），后续项是思想方法/素养标签（如「转化思想、综合法、数学运算」），
// 有些条目本身是「、」分隔的组合串。匹配策略刻意保守：
//
//   1. 归一化（trim + 大小写折叠 + 全角/半角空白统一）后做 EXACT name 匹配，作用域
//      限定在目标 subject domain 的 live（未归档）节点内；
//   2. 组合串按「、」拆开逐段尝试；
//   3. 命中的段 → knowledge_id；全部未命中 → unmatched 原样返回（调用方决定 coarse
//      挂载或交给 agent 提议——本模块不做模糊/语义匹配，那属于 LLM 判断路径）。
//
// 纯函数 + 一次树查询；同名节点（不应存在但防御）取第一个并记入 ambiguous。

import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';

export interface JyeooHintMatchResult {
  /** hint 段 → 命中的知识节点（按输入顺序去重）。 */
  matched: Array<{ hint: string; knowledgeId: string; knowledgeName: string }>;
  /** 未能匹配的原始 hint（含组合串整体均未命中的）。 */
  unmatched: string[];
  /** 归一化后重名节点数 >1 的 hint 段（取首个；记录以便审计树卫生）。 */
  ambiguous: string[];
}

export function normalizeHint(raw: string): string {
  return raw
    .trim()
    .replace(/[　\s]+/g, ' ')
    .toLowerCase();
}

/** 把一条 hint 拆成候选段：整体 + 「、」分段（去重、去空）。 */
export function hintSegments(hint: string): string[] {
  const parts = hint
    .split('、')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...new Set([hint.trim(), ...parts].filter((part) => part.length > 0))];
}

/**
 * 在指定 domain 的活树内做 hints 精确名匹配。root fallback（科目根）不在本函数内——
 * 调用方在 unmatched 非空时自行决定（保持本函数单一职责 + 纯匹配语义）。
 *
 * 树不变量：只有根节点直接携带 domain，子节点 domain=null 沿 parent 链继承
 * （getEffectiveDomain / batchResolveEffectiveDomains 同款解析）。故本函数全量装载
 * 活节点后按 parent 链求 effective domain，再按目标 domain 过滤——直接按
 * `knowledge.domain = ?` 查询只会命中根节点（YUK-986 实现期修掉的真 bug）。
 */
export async function matchJyeooKnowledgeHints(
  db: Db,
  domain: string,
  hints: string[],
): Promise<JyeooHintMatchResult> {
  const result: JyeooHintMatchResult = { matched: [], unmatched: [], ambiguous: [] };
  if (hints.length === 0) return result;

  const rows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const effectiveDomain = (id: string): string | null => {
    let cur = byId.get(id);
    for (let depth = 0; depth < 64 && cur; depth += 1) {
      if (cur.domain !== null) return cur.domain;
      if (cur.parent_id === null) return null;
      cur = byId.get(cur.parent_id);
    }
    return null;
  };
  const byNormalizedName = new Map<string, Array<{ id: string; name: string }>>();
  for (const node of rows) {
    if (effectiveDomain(node.id) !== domain) continue;
    const key = normalizeHint(node.name);
    const bucket = byNormalizedName.get(key) ?? [];
    bucket.push(node);
    byNormalizedName.set(key, bucket);
  }

  const matchedKnowledgeIds = new Set<string>();
  for (const hint of hints) {
    let hit: { id: string; name: string } | null = null;
    let hitSegment: string | null = null;
    for (const segment of hintSegments(hint)) {
      const bucket = byNormalizedName.get(normalizeHint(segment));
      if (bucket && bucket.length > 0) {
        hit = bucket[0] ?? null;
        hitSegment = segment;
        if (bucket.length > 1 && !result.ambiguous.includes(segment)) {
          result.ambiguous.push(segment);
        }
        break;
      }
    }
    if (hit && hitSegment) {
      if (!matchedKnowledgeIds.has(hit.id)) {
        matchedKnowledgeIds.add(hit.id);
        result.matched.push({ hint: hitSegment, knowledgeId: hit.id, knowledgeName: hit.name });
      }
    } else {
      result.unmatched.push(hint);
    }
  }
  return result;
}

/**
 * 科目根节点（domain 直接携带者——知识树不变量：根节点 domain 非空，子节点 domain=null
 * 沿 parent 链继承，见 getEffectiveDomain）。找不到返回 null（调用方不得静默挂错科目）。
 */
export async function findSubjectRootKnowledgeId(db: Db, domain: string): Promise<string | null> {
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(eq(knowledge.domain, domain), isNull(knowledge.archived_at)))
    .limit(1);
  return rows[0]?.id ?? null;
}
