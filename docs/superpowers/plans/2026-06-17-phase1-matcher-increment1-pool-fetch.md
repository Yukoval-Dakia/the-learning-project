# Phase 1 增量 1 — 统一 pool-fetch 算子 + hybrid 检索证明

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`. **TDD**。
>
> **依赖**：Phase 0（#439，pgvector 列 + embedder + GIN）已在 main。**前置**：`docs/superpowers/research/2026-06-17-phase1-matcher-scoping.md`（消费者清单 + 软维度 + 供给引擎 LIVE 修正 + effective_domain app-layer 约束）。
>
> **起点**：从**当时 origin/main**（含 #439 Phase 0）新建 worktree + 分支；迁移号取实现时 `pnpm db:generate`（本增量预计**无迁移**，纯查询算子）。

**Goal:** 落地一个统一 `poolFetch(db, criteria)` 算子——把散落各处的题池查询（原型 `queryExistingPool`）泛化为「权威 scalar 过滤 + KC containment + **可选** pgvector 相似度排序」，并用 db 测试证明 hybrid 查询（`ORDER BY embedding <=> $qvec`）跑通。

**Architecture:** 新增 `src/server/quiz/pool-fetch.ts` 暴露 `poolFetch`。scalar 谓词复刻 `queryExistingPool`（`sourcing-sequence.ts:111-142`）的现有契约（KC `knowledge_ids @> [id]::jsonb` GIN、孤儿 draft 排除、difficulty floor、`unit='篇'` composite 派生）。新增 **可选 `queryEmbedding`**：传入则 `isNotNull(embedding)` + `ORDER BY embedding <=> ${toSqlVector(qvec)}::vector`（pgvector cosine 距离，customType 文本字面量 `src/db/vector.ts`）；不传则退回 `created_at,id`（与原型一致）。**本增量不迁移任何 live 消费者**（避免动 sourcing 热路径），只建算子 + 证 hybrid；消费者迁移 = 增量 2（带严格等价测试）。

**Tech Stack:** Drizzle（`sql` 模板 + pgvector）、`src/db/vector.ts` `toSqlVector`、`src/server/ai/embed.ts` `embedText`（DashScope text-embedding-v4，1024d）、Vitest db config（testcontainer）。

---

## 不在本增量（明确缓做，见 scoping note）

- 软维度（错因/掌握/考纲）过滤——未物化为列；增量 1 不碰。
- 跨 KC / domain 池（`effective_domain` 是 app-layer 派生 `subject.ts:131`，不能裸 WHERE）——增量 1 单 KC。
- 接线 `discoverSupplyTargets`/`dispatcher`（**已 LIVE**）——迁移 = 增量 2+。
- embed-on-write 新鲜度（YUK-393）——matcher 真上线前的依赖，非本增量。

---

## File Structure

- **Create** `src/server/quiz/pool-fetch.ts` — `poolFetch(db, criteria)` + `PoolFetchCriteria`/`PoolRow` 类型。
- **Create** `src/server/quiz/pool-fetch.db.test.ts` — scalar 等价 + hybrid 排序 db 测试。
- **不改** `sourcing-sequence.ts`（增量 2 再迁 `queryExistingPool`）。

---

## Tasks（TDD）

### Task 1: `PoolFetchCriteria` 类型 + scalar-only `poolFetch`（无向量，等价 queryExistingPool 的 SQL 层）
**Files:** Create `src/server/quiz/pool-fetch.ts`, `src/server/quiz/pool-fetch.db.test.ts`

- [ ] **Step 1 — 失败 db 测试**（`pool-fetch.db.test.ts`）：seed 3 个 question 同一 KC（2 active 不同 difficulty + 1 `draft_status='draft'`）；`poolFetch(db,{knowledgeId, activeOnly:true, difficultyMin:3})` 只返 difficulty≥3 的 active 行，draft 排除。

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, testDb } from '@/../tests/helpers/db';
import { poolFetch } from '@/server/quiz/pool-fetch';
// seed helper: insert question rows with given knowledge_ids/difficulty/draft_status

describe('poolFetch scalar', () => {
  beforeEach(async () => { await resetDb(); });
  it('filters by KC containment + active + difficulty floor', async () => {
    const kc = 'kc-1';
    await seedQuestion({ id: 'q1', knowledge_ids: [kc], difficulty: 2, draft_status: null });
    await seedQuestion({ id: 'q2', knowledge_ids: [kc], difficulty: 4, draft_status: null });
    await seedQuestion({ id: 'q3', knowledge_ids: [kc], difficulty: 5, draft_status: 'draft' });
    const rows = await poolFetch(testDb, { knowledgeId: kc, activeOnly: true, difficultyMin: 3 });
    expect(rows.map((r) => r.id).sort()).toEqual(['q2']);
  });
});
```

- [ ] **Step 2 — run, 确认 fail**（`pnpm vitest run --config vitest.db.config.ts src/server/quiz/pool-fetch.db.test.ts`）：FAIL（poolFetch 未定义）。
- [ ] **Step 3 — 实现 scalar `poolFetch`**：

```ts
import { and, asc, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';

export interface PoolFetchCriteria {
  knowledgeId: string;               // 增量 1：单 KC（knowledge_ids @> [id])
  activeOnly?: boolean;              // default true：draft_status IS NULL OR <> 'draft'
  difficultyMin?: number | null;
  difficultyMax?: number | null;
  compositeParentOnly?: boolean;    // unit='篇'：parent_question_id IS NULL AND EXISTS child
  queryEmbedding?: number[] | null; // 传入则 hybrid（Task 4）
  limit?: number;
}
export interface PoolRow { id: string; difficulty: number; }

export async function poolFetch(db: Db, c: PoolFetchCriteria): Promise<PoolRow[]> {
  const preds = [
    sql`${question.knowledge_ids} @> ${JSON.stringify([c.knowledgeId])}::jsonb`,
  ];
  if (c.activeOnly !== false) {
    preds.push(sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`);
  }
  if (c.difficultyMin != null) preds.push(sql`${question.difficulty} >= ${c.difficultyMin}`);
  if (c.difficultyMax != null) preds.push(sql`${question.difficulty} <= ${c.difficultyMax}`);
  if (c.compositeParentOnly) {
    preds.push(isNull(question.parent_question_id));
    preds.push(sql`EXISTS (SELECT 1 FROM ${question} AS c WHERE c.parent_question_id = ${question.id})`);
  }
  const q = db
    .select({ id: question.id, difficulty: question.difficulty })
    .from(question)
    .where(and(...preds))
    .orderBy(asc(question.created_at), asc(question.id));
  const rows = c.limit != null ? await q.limit(c.limit) : await q;
  return rows;
}
```

- [ ] **Step 4 — run, 确认 pass**。
- [ ] **Step 5 — commit**（Refs Phase 1；`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`）。

### Task 2: scalar 算子与 `queryExistingPool` SQL 谓词等价（防回归地基）
- [ ] **Step 1 — 失败测试**：同一 seed 下，`poolFetch` 的 id 集 == `queryExistingPool` 的 SQL where 命中（不含其 in-memory tier 排序——只比 WHERE 命中集）。覆盖 `unit='篇'` composite 分支：seed parent + child part，断 `compositeParentOnly:true` 只返 parent。
- [ ] **Step 2-4 — run-fail / 调谓词到字节等价 / run-pass**。`unit='篇'` 用 `parent_question_id IS NULL AND EXISTS(child)`，与 `sourcing-sequence.ts:136-137` 同。
- [ ] **Step 5 — commit**。

### Task 3: hybrid 向量排序（pgvector，证明本增量核心能力）
- [ ] **Step 1 — 失败 db 测试**：seed 3 个 active question 同 KC，写已知 `embedding`（直接 INSERT 向量，不调真 embedder——测试确定性）；传 `queryEmbedding` = 最接近 q2 的向量，断返回顺序 q2 first。

```ts
it('orders by cosine distance when queryEmbedding given', async () => {
  const kc = 'kc-vec';
  await seedQuestionWithEmbedding({ id: 'qa', knowledge_ids: [kc], embedding: unit([1,0,...]) });
  await seedQuestionWithEmbedding({ id: 'qb', knowledge_ids: [kc], embedding: unit([0,1,...]) });
  const rows = await poolFetch(testDb, { knowledgeId: kc, queryEmbedding: unit([0.9,0.1,...]) });
  expect(rows[0].id).toBe('qa'); // 最近
});
```

- [ ] **Step 2 — run-fail**。
- [ ] **Step 3 — 加 hybrid 分支**到 `poolFetch`：`queryEmbedding` 非空时 → 加 `sql\`${question.embedding} IS NOT NULL\``（NULL embedding 不参与相似度）+ 改 orderBy：

```ts
import { toSqlVector } from '@/db/vector';
// ... inside poolFetch, replace orderBy when c.queryEmbedding:
if (c.queryEmbedding && c.queryEmbedding.length > 0) {
  preds.push(sql`${question.embedding} IS NOT NULL`);
  const order = sql`${question.embedding} <=> ${toSqlVector(c.queryEmbedding)}::vector`;
  // build query with this orderBy instead of created_at
}
```
（`<=>` = pgvector cosine 距离；`::vector` cast 文本字面量。注意 customType 列名固定 `embedding`，`question.embedding` 投影需在 schema 已声明——Phase 0 已加。）

- [ ] **Step 4 — run-pass**。
- [ ] **Step 5 — commit**。

### Task 4（增量 2 预告，本增量末仅留 TODO 注释，不实现）
迁移首个真实消费者（`queryExistingPool`）到 `poolFetch`——需严格「迁移前后 id 集 + tier 排序逐项相等」回归（hot 路径，独立 reviewer）。本增量**不做**，避免动 sourcing 热路径。

---

## Gate（本增量）
- [ ] `pnpm vitest run --config vitest.db.config.ts src/server/quiz/pool-fetch.db.test.ts` 全绿。
- [ ] 全 gate：typecheck/lint/audit×4/test/build（**串行单跑，防 OOM**）。
- [ ] 独立 Opus reviewer：算子谓词与 queryExistingPool 契约等价、hybrid `<=>` cast 正确、NULL embedding 处理、无 hot 路径触碰。

## Self-Review
- 本增量**零迁移**（纯查询）；若 `pnpm db:generate` 产出迁移说明误碰 schema，停查。
- 不接 supply 链（已 LIVE，迁移属增量 2+）。
- 单 KC 作用域；跨 KC/domain + 软维度 = 后续增量。
