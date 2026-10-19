// YUK-1572 — knowledge id → 显示名批量读取（自 stream-inputs.ts 拆出）。
//
// 这是一条完整的事实读取职责，不属于任何一侧编排：stream-inputs 用它给候选
// 注 reasoning 标签，stream-view 用它投影 knowledge_name。两侧经本模块共用
// 同一事实源，互不依赖对方的编排实现。

import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';

/** 本模块的 DB 句柄：既可是顶层 `db`，也可是事务内 `tx`。 */
type DbLike = Db | Tx;

/**
 * knowledge id → 显示名批量解析。id 先去重并滤空；表内不存在的 id 不出现于
 * 结果（调用方以 `map.get(id)` 的 undefined 处理缺失）。
 */
export async function knowledgeLabels(db: DbLike, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}
