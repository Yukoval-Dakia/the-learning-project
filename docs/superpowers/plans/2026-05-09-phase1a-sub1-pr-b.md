# Phase 1a Sub 1 PR B — 高阶 mutation + KnowledgeReviewTask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落 spec § 3.9 PR B —— 4 类高阶 mutation apply (reparent/merge/split/archive) + acceptProposal switch 扩展 + 'stale' 状态 + KnowledgeReviewTask（流 + tool calling）+ POST /api/knowledge/review + UI 扩展（tree 顶部 "AI review" 按钮 + proposal 页支持全部 5 类 mutation）。

**Architecture:** 4 个 apply 函数加在已有 `workers/src/knowledge/proposals.ts`（PR A 落地），每个用 race-safe pattern：UPDATE/INSERT 含 `WHERE version=expected_version AND archived_at IS NULL`，meta.changes != 1 把 dreaming_proposal.status 设 `stale`。streamReviewTask 单独抽到 `workers/src/knowledge/review.ts`（输入 = full tree + recent mistakes，工具 = `write_proposal`，每次 tool call 写一条 dreaming_proposal）。POST /api/knowledge/review 在已有 knowledge 路由扩展，返 streaming Response。Client UI：knowledge.tsx 加按钮 + 流式文本展示，knowledge-proposals.tsx 扩展 payload preview 渲染 + enable approve 按钮。

**Tech Stack:** Drizzle d1（已有）+ Hono routing 扩展 + AI SDK v6 streamText with tools（PR 2 已 ship 模式）+ MockLanguageModelV3 (`ai/test`) for V3 stream + tool-call mocks + TanStack Query v5 useMutation（PR A 已 ship）。

**Spec reference:** `docs/superpowers/specs/2026-05-09-phase1a-design.md` § 3.3 (5 类 mutation) / § 3.4 (Tasks) / § 3.5 (APIs) / § 3.6 (Approval engine) / § 3.7 (UI) / § 3.9 PR B。

**Decisions resolved（实施前用户已 confirm）:**
- KnowledgeReviewTask 走 **流 + tool calling**（write_proposal 工具）—— spec 模式
- Optimistic lock 走 **AI propose 时快照 version + apply 时 WHERE version=? 验证**（changes=0 → stale）
- Reparent 把节点变 root（new_parent_id=null）—— **拒绝**（Phase 1a 单 domain，跟 PR A applyProposeNew root creation 同 guard）
- **Deviation from spec § 3.3**：`merge` 不重写 `mistake.knowledge_ids` / `question.knowledge_ids` JSON 数组（同 split 处理）。理由：SQLite JSON in-place rewrite ergonomically 复杂；保留 archived 节点引用 = 审计痕迹。UI 在读取 mistake 详情时跟 `merged_from` 跳到 into_id（Sub 4 复习 UI 时实现，PR B 不做）。如用户希望走 spec 严格语义，PR B 后加 followup task。

---

## File Structure

### 创建（新文件）

- `workers/src/knowledge/review.ts` — `streamReviewTask(db, env, model?)` 包装 streamTask + write_proposal tool
- `workers/src/knowledge/review.test.ts` — 单测（MockLanguageModelV3 + tool-call chunks）

### 修改（已有文件）

- `workers/src/knowledge/proposals.ts` — 加 `applyReparent` / `applyArchive` / `applySplit` / `applyMerge` + 每个的 accept-wrapper + 扩展 `acceptProposal` switch + 新 `markProposalStale`
- `workers/src/knowledge/proposals.test.ts` — 加 4 类 apply 测 + acceptProposal 多类 dispatch 测 + stale 路径测
- `workers/src/routes/knowledge.ts` — 加 `POST /review` endpoint + 扩展 decide 错误映射含 'stale' → 409
- `workers/src/routes/knowledge.test.ts` — 加 review endpoint 测 + stale 错误响应测
- `src/ai/registry.ts` — 加 `KnowledgeReviewTask` 条目
- `src/core/schema/index.ts` — `DreamingProposal.status` Zod enum 加 `'stale'`
- `src/core/schema/schema.test.ts` — 加 stale status accept 测
- `src/routes/knowledge.tsx` — 顶部加 "AI review my tree" 按钮 + 流式文本展示
- `src/routes/knowledge-proposals.tsx` — 扩展支持全部 5 类 mutation payload 渲染 + enable approve 按钮 for non-propose_new + 新 stale 状态显示

### 不动

- `src/db/schema.ts` — `dreaming_proposal.status` 是 free `text`，schema 层不约束 enum；只在 Zod 层加 'stale'。无 migration 需要
- `workers/src/knowledge/seed.ts` / `domain.ts`
- `workers/src/index.ts` — knowledge router 已 mount；review endpoint 加在 sub-router 内

---

## Tasks

---

### Task 1: `applyReparent` + 收紧 `assertParentExists`（archived guard）

**Files:**
- Modify: `workers/src/knowledge/proposals.ts`
- Modify: `workers/src/knowledge/proposals.test.ts`

**Goal:** Race-safe `applyReparent(db, payload)`：UPDATE knowledge.parent_id WHERE version=expected_version AND archived_at IS NULL；root→child 时同步 set domain=NULL。Reject `new_parent_id=null`（Phase 1a 单 domain root 禁创）。同时收紧 PR A 的 `assertParentExists` 也排除 archived parent（PR A 漏掉的 edge case，inline fix）。

- [ ] **Step 1: Write failing tests**

Edit `workers/src/knowledge/proposals.test.ts`，在文件末尾（最后 `});` 后）加：

```ts
import { applyReparent } from './proposals';

describe('applyReparent', () => {
  it('moves a child node to a new parent (happy path)', async () => {
    const { db, calls } = makeMockDb({
      knowledge: {
        k_node: { id: 'k_node', parent_id: 'k_oldparent', version: 3, archived_at: null },
        k_newparent: { id: 'k_newparent', archived_at: null },
      },
    });
    await applyReparent(db, {
      mutation: 'reparent',
      node_id: 'k_node',
      new_parent_id: 'k_newparent',
      expected_version: 3,
    });
    const update = calls.find((c) => /update knowledge/i.test(c.sql) && /parent_id/i.test(c.sql));
    expect(update).toBeDefined();
    // bind order: parent_id, updated_at, id, expected_version
    expect(update?.binds[0]).toBe('k_newparent');
    expect(update?.binds[2]).toBe('k_node');
    expect(update?.binds[3]).toBe(3);
  });

  it('rejects reparent → null (root creation, PR A guard)', async () => {
    const { db } = makeMockDb({});
    await expect(
      applyReparent(db, {
        mutation: 'reparent',
        node_id: 'k_node',
        new_parent_id: null,
        expected_version: 3,
      }),
    ).rejects.toThrow(/root.*not supported/i);
  });

  it('rejects when parent is archived', async () => {
    const { db } = makeMockDb({
      knowledge: {
        k_archived: { id: 'k_archived', archived_at: 1700000000 },
      },
    });
    await expect(
      applyReparent(db, {
        mutation: 'reparent',
        node_id: 'k_node',
        new_parent_id: 'k_archived',
        expected_version: 1,
      }),
    ).rejects.toThrow(/parent.*not found/i);
  });

  it('throws stale error when version mismatch (changes=0)', async () => {
    const { db } = makeMockDb({
      knowledge: { k_newparent: { id: 'k_newparent', archived_at: null } },
      runZeroChangesFor: /update knowledge/i,
    });
    await expect(
      applyReparent(db, {
        mutation: 'reparent',
        node_id: 'k_node',
        new_parent_id: 'k_newparent',
        expected_version: 3,
      }),
    ).rejects.toThrow(/stale.*version/i);
  });
});
```

加 mock 选项 `runZeroChangesFor`（让指定 SQL pattern 的 run() 返 changes=0）—— 修改 `makeMockDb` 上方接口：

```ts
interface MockOptions {
  proposals?: Record<string, Record<string, unknown>>;
  knowledge?: Record<string, Record<string, unknown>>;
  /** Force the next batch's UPDATE statement to report 0 row changes (race simulation). */
  raceUpdateZeroChanges?: boolean;
  /** Force any prepare/run matching this regex to report 0 row changes (stale simulation). */
  runZeroChangesFor?: RegExp;
}
```

并在 `prepare(...).bind(...).run` 那里：

```ts
        run: async () => {
          if (opts.runZeroChangesFor && opts.runZeroChangesFor.test(sql)) {
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
```

并在 `assertParentExists`-style first() 也要尊重 archived 字段：原 PR A 的 first() 只查 `select id from knowledge where id = ?`，现在 SQL 会变成 `... where id = ? and archived_at is null`，mock 需要看 SQL 里是否含 `archived_at is null` 子句来过滤。修改 mock 的 first()：

```ts
        first: async () => {
          if (/from dreaming_proposal where id = \?/i.test(sql)) {
            return tableRows.dreaming_proposal[binds[0] as string] ?? null;
          }
          if (/select id from knowledge where id = \?/i.test(sql)) {
            const row = tableRows.knowledge[binds[0] as string];
            if (!row) return null;
            // honor archived guard if SQL includes it
            if (/archived_at is null/i.test(sql) && row.archived_at != null) return null;
            return row;
          }
          return null;
        },
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: 4 new tests FAIL（`applyReparent` 未导出 + 'rejects when parent is archived' 因 PR A `assertParentExists` 还没 archived guard，也失败）。

- [ ] **Step 3: Implement `applyReparent` + 收紧 `assertParentExists`**

Edit `workers/src/knowledge/proposals.ts`，把现有 `assertParentExists` 替换为：

```ts
async function assertParentExists(db: D1Database, parentId: string): Promise<void> {
  const row = await db
    .prepare(`select id from knowledge where id = ? and archived_at is null`)
    .bind(parentId)
    .first<{ id: string }>();
  if (!row) {
    throw new Error(`parent knowledge node not found or archived: ${parentId}`);
  }
}
```

在 `dismissProposal` 之前加新函数：

```ts
/**
 * Apply reparent: change a node's parent_id under optimistic lock.
 *
 * Phase 1a single-domain: rejects new_parent_id=null (root creation) — same guard
 * as applyProposeNew. When the node was a root (parent_id IS NULL, domain set),
 * the UPDATE also clears domain so the inheritance invariant holds.
 */
export async function applyReparent(
  db: D1Database,
  payload: ReparentPayload,
): Promise<void> {
  if (payload.new_parent_id === null) {
    throw new Error(
      'PR B: reparent to root (new_parent_id=null) not supported in Phase 1a single-domain',
    );
  }
  await assertParentExists(db, payload.new_parent_id);
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `update knowledge
        set parent_id = ?, domain = NULL, updated_at = ?, version = version + 1
        where id = ? and version = ? and archived_at is null`,
    )
    .bind(payload.new_parent_id, now, payload.node_id, payload.expected_version)
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes !== 1) {
    throw new Error(`stale: knowledge ${payload.node_id} version mismatch or archived`);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: PASS, 全部 11 tests（既有 7 + 新 4）。**Caveat**：PR A 的 `applyProposeNew` 测 ('inserts a new knowledge row with status=approved') 的 mock 使 `seed:wenyan:shici` 不带 `archived_at` 字段 → mock undefined != null pass。如果 Step 3 收紧后这条测 fail（`archived_at is null` 严格过滤），update mock seed 行加 `archived_at: null`：

```ts
knowledge: { 'seed:wenyan:shici': { id: 'seed:wenyan:shici', archived_at: null } },
```

类似的 mock 调整应用到所有受影响的现有测（搜 `seed:wenyan:shici`，每处加 `archived_at: null`）。

- [ ] **Step 5: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error。

- [ ] **Step 6: Commit**

```bash
git add workers/src/knowledge/proposals.ts workers/src/knowledge/proposals.test.ts
git commit -m "feat(knowledge): applyReparent + tighten assertParentExists archived guard"
```

---

### Task 2: `applyArchive`

**Files:**
- Modify: `workers/src/knowledge/proposals.ts`
- Modify: `workers/src/knowledge/proposals.test.ts`

**Goal:** Soft-delete a node：set `archived_at` + bump version。Race-safe: `WHERE version=? AND archived_at IS NULL`，changes=0 → stale。

- [ ] **Step 1: Write failing tests**

Edit `workers/src/knowledge/proposals.test.ts`，在 `describe('applyReparent', ...` 后加：

```ts
import { applyArchive } from './proposals';

describe('applyArchive', () => {
  it('archives a node and bumps version (happy path)', async () => {
    const { db, calls } = makeMockDb({
      knowledge: { k_node: { id: 'k_node', archived_at: null, version: 5 } },
    });
    await applyArchive(db, {
      mutation: 'archive',
      node_id: 'k_node',
      expected_version: 5,
    });
    const update = calls.find((c) => /update knowledge/i.test(c.sql) && /archived_at = \?/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update?.binds[2]).toBe('k_node'); // id
    expect(update?.binds[3]).toBe(5); // expected_version
  });

  it('throws stale error when already archived (changes=0)', async () => {
    const { db } = makeMockDb({
      knowledge: { k_node: { id: 'k_node', archived_at: 1700000000, version: 5 } },
      runZeroChangesFor: /update knowledge/i,
    });
    await expect(
      applyArchive(db, {
        mutation: 'archive',
        node_id: 'k_node',
        expected_version: 5,
      }),
    ).rejects.toThrow(/stale/i);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: 2 new tests FAIL — `applyArchive` 未导出。

- [ ] **Step 3: Implement `applyArchive`**

Edit `workers/src/knowledge/proposals.ts`，在 `applyReparent` 之后加：

```ts
/**
 * Apply archive: soft-delete a node by setting archived_at + bumping version.
 * Race-safe via WHERE version=? AND archived_at IS NULL — changes=0 → stale.
 */
export async function applyArchive(
  db: D1Database,
  payload: ArchivePayload,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `update knowledge
        set archived_at = ?, updated_at = ?, version = version + 1
        where id = ? and version = ? and archived_at is null`,
    )
    .bind(now, now, payload.node_id, payload.expected_version)
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes !== 1) {
    throw new Error(`stale: knowledge ${payload.node_id} version mismatch or already archived`);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: PASS, 13 tests。

- [ ] **Step 5: Commit**

```bash
git add workers/src/knowledge/proposals.ts workers/src/knowledge/proposals.test.ts
git commit -m "feat(knowledge): applyArchive (soft-delete + version bump)"
```

---

### Task 3: `applySplit`

**Files:**
- Modify: `workers/src/knowledge/proposals.ts`
- Modify: `workers/src/knowledge/proposals.test.ts`

**Goal:** archive `from_id` + insert N new children。Race-safe via batch with conditional INSERT…SELECT…WHERE EXISTS。每个 `into[i].parent_id` must exist & not archived。`mistake.knowledge_ids` / `question.knowledge_ids` JSON 不动（per spec § 3.3 fix）。

- [ ] **Step 1: Write failing tests**

Edit `workers/src/knowledge/proposals.test.ts`，加：

```ts
import { applySplit } from './proposals';

describe('applySplit', () => {
  it('archives from + inserts N new children (happy path)', async () => {
    const { db, calls } = makeMockDb({
      knowledge: {
        k_from: { id: 'k_from', archived_at: null, version: 7 },
        k_p1: { id: 'k_p1', archived_at: null },
        k_p2: { id: 'k_p2', archived_at: null },
      },
    });
    const newIds = await applySplit(db, {
      mutation: 'split',
      from_id: 'k_from',
      into: [
        { name: 'A', parent_id: 'k_p1' },
        { name: 'B', parent_id: 'k_p2' },
      ],
      expected_version: 7,
    });
    expect(newIds).toHaveLength(2);
    const inserts = calls.filter((c) => /insert into knowledge/i.test(c.sql));
    expect(inserts).toHaveLength(2);
    const archive = calls.find((c) => /update knowledge/i.test(c.sql) && /archived_at/i.test(c.sql));
    expect(archive).toBeDefined();
  });

  it('rejects split with into[].parent_id=null (root creation)', async () => {
    const { db } = makeMockDb({
      knowledge: { k_from: { id: 'k_from', archived_at: null, version: 1 } },
    });
    await expect(
      applySplit(db, {
        mutation: 'split',
        from_id: 'k_from',
        into: [{ name: 'A', parent_id: null }],
        expected_version: 1,
      }),
    ).rejects.toThrow(/root.*not supported/i);
  });

  it('throws stale when archive UPDATE returns 0 changes', async () => {
    const { db } = makeMockDb({
      knowledge: {
        k_from: { id: 'k_from', archived_at: null, version: 7 },
        k_p1: { id: 'k_p1', archived_at: null },
      },
      raceUpdateZeroChanges: true,
    });
    await expect(
      applySplit(db, {
        mutation: 'split',
        from_id: 'k_from',
        into: [{ name: 'A', parent_id: 'k_p1' }],
        expected_version: 7,
      }),
    ).rejects.toThrow(/stale/i);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: 3 new tests FAIL — `applySplit` 未导出。

- [ ] **Step 3: Implement `applySplit`**

Edit `workers/src/knowledge/proposals.ts`，加：

```ts
/**
 * Apply split: archive from_id + insert N new children. Each into[i].parent_id must
 * exist and not be archived. Phase 1a single-domain: rejects parent_id=null entries.
 *
 * mistake/question.knowledge_ids JSON arrays are NOT rewritten — they continue to
 * reference the archived from_id. Read-side UI follows merged_from / archived_at
 * to surface "tag was split" hint. (Deviation from spec § 3.3 — see plan header.)
 *
 * Race-safe via batch: archive UPDATE gates by expected_version; inserts use
 * INSERT…SELECT…WHERE EXISTS gated on the same version not yet bumped.
 */
export async function applySplit(
  db: D1Database,
  payload: SplitPayload,
): Promise<string[]> {
  for (const entry of payload.into) {
    if (entry.parent_id === null) {
      throw new Error(
        'PR B: split into root (parent_id=null) not supported in Phase 1a single-domain',
      );
    }
    await assertParentExists(db, entry.parent_id);
  }
  const now = Math.floor(Date.now() / 1000);
  const newIds: string[] = payload.into.map(() => createId());
  const archiveStmt = db
    .prepare(
      `update knowledge
        set archived_at = ?, updated_at = ?, version = version + 1
        where id = ? and version = ? and archived_at is null`,
    )
    .bind(now, now, payload.from_id, payload.expected_version);
  const insertStmts = payload.into.map((entry, i) =>
    db
      .prepare(
        `insert into knowledge (
          id, name, domain, parent_id, base_mastery, ai_delta_mastery,
          merged_from, proposed_by_ai, approval_status, created_at, updated_at, version
        )
        select ?, ?, NULL, ?, 0, 0, '[]', 1, 'approved', ?, ?, 0
        where exists (
          select 1 from knowledge where id = ? and version = ?
        )`,
      )
      .bind(
        newIds[i],
        entry.name,
        entry.parent_id,
        now,
        now,
        payload.from_id,
        payload.expected_version + 1,
      ),
  );
  const results = await db.batch([archiveStmt, ...insertStmts]);
  const archiveChanges =
    (results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
  if (archiveChanges !== 1) {
    throw new Error(`stale: knowledge ${payload.from_id} version mismatch or already archived`);
  }
  return newIds;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: PASS, 16 tests。

- [ ] **Step 5: Commit**

```bash
git add workers/src/knowledge/proposals.ts workers/src/knowledge/proposals.test.ts
git commit -m "feat(knowledge): applySplit (archive + N inserts, race-safe)"
```

---

### Task 4: `applyMerge`

**Files:**
- Modify: `workers/src/knowledge/proposals.ts`
- Modify: `workers/src/knowledge/proposals.test.ts`

**Goal:** Archive 全部 `from_ids` + push to `into.merged_from`。`mistake.knowledge_ids` / `question.knowledge_ids` 不重写（同 split）。每个 `from_ids[i]` 各有自己的 `expected_versions[i]`；任何一项 mismatch → stale。

- [ ] **Step 1: Write failing tests**

Edit `workers/src/knowledge/proposals.test.ts`，加：

```ts
import { applyMerge } from './proposals';

describe('applyMerge', () => {
  it('archives all from_ids + pushes to into.merged_from (happy path)', async () => {
    const { db, calls } = makeMockDb({
      knowledge: {
        k_from1: { id: 'k_from1', archived_at: null, version: 2 },
        k_from2: { id: 'k_from2', archived_at: null, version: 4 },
        k_into: { id: 'k_into', archived_at: null, version: 1, merged_from: '[]' },
      },
    });
    await applyMerge(db, {
      mutation: 'merge',
      from_ids: ['k_from1', 'k_from2'],
      into_id: 'k_into',
      expected_versions: { k_from1: 2, k_from2: 4 },
    });
    const archives = calls.filter(
      (c) => /update knowledge/i.test(c.sql) && /archived_at = \?/i.test(c.sql),
    );
    expect(archives).toHaveLength(2);
    const intoUpdate = calls.find(
      (c) => /update knowledge/i.test(c.sql) && /merged_from/i.test(c.sql),
    );
    expect(intoUpdate).toBeDefined();
  });

  it('rejects when into_id is in from_ids', async () => {
    const { db } = makeMockDb({});
    await expect(
      applyMerge(db, {
        mutation: 'merge',
        from_ids: ['k_a', 'k_into'],
        into_id: 'k_into',
        expected_versions: { k_a: 1, k_into: 1 },
      }),
    ).rejects.toThrow(/into_id.*from_ids/i);
  });

  it('rejects when expected_versions missing for a from_id', async () => {
    const { db } = makeMockDb({});
    await expect(
      applyMerge(db, {
        mutation: 'merge',
        from_ids: ['k_a', 'k_b'],
        into_id: 'k_into',
        expected_versions: { k_a: 1 }, // missing k_b
      }),
    ).rejects.toThrow(/expected_versions.*k_b/i);
  });

  it('throws stale when any archive UPDATE returns 0 changes', async () => {
    const { db } = makeMockDb({
      knowledge: {
        k_from1: { id: 'k_from1', archived_at: null, version: 2 },
        k_into: { id: 'k_into', archived_at: null, version: 1, merged_from: '[]' },
      },
      raceUpdateZeroChanges: true,
    });
    await expect(
      applyMerge(db, {
        mutation: 'merge',
        from_ids: ['k_from1'],
        into_id: 'k_into',
        expected_versions: { k_from1: 2 },
      }),
    ).rejects.toThrow(/stale/i);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: 4 new tests FAIL — `applyMerge` 未导出。

- [ ] **Step 3: Implement `applyMerge`**

Edit `workers/src/knowledge/proposals.ts`，加：

```ts
/**
 * Apply merge: archive all from_ids + push their ids onto into.merged_from JSON array.
 *
 * mistake/question.knowledge_ids JSON arrays are NOT rewritten (deviation from spec § 3.3
 * — see plan header). Read-side UI follows merged_from to surface tag-was-merged hint.
 *
 * Race-safe via batch: each archive UPDATE gates by its own expected_version; the into
 * UPDATE bumps version unconditionally (lock on into not strictly needed since we only
 * append — concurrent merges into the same node are commutative on merged_from but version
 * still bumps).
 */
export async function applyMerge(
  db: D1Database,
  payload: MergePayload,
): Promise<void> {
  if (payload.from_ids.includes(payload.into_id)) {
    throw new Error(`merge: into_id (${payload.into_id}) cannot also appear in from_ids`);
  }
  for (const fromId of payload.from_ids) {
    if (!(fromId in payload.expected_versions)) {
      throw new Error(`merge: expected_versions missing entry for ${fromId}`);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const archiveStmts = payload.from_ids.map((fromId) =>
    db
      .prepare(
        `update knowledge
          set archived_at = ?, updated_at = ?, version = version + 1
          where id = ? and version = ? and archived_at is null`,
      )
      .bind(now, now, fromId, payload.expected_versions[fromId]),
  );
  // Append from_ids onto into.merged_from JSON array.
  // SQLite json() and json_insert / json_array_append patterns are awkward; we read-modify-write
  // in a single statement using json_each replacement: simpler to use json_set with -1 indexing.
  // For Phase 1a self-use this single-row read+write is fine; race window is bounded by version bump.
  const intoUpdate = db
    .prepare(
      `update knowledge
        set merged_from = json(
          (select json_group_array(value) from (
            select value from json_each(merged_from) union all
            select value from json_each(?)
          ))
        ), updated_at = ?, version = version + 1
        where id = ? and archived_at is null`,
    )
    .bind(JSON.stringify(payload.from_ids), now, payload.into_id);
  const results = await db.batch([...archiveStmts, intoUpdate]);
  for (let i = 0; i < archiveStmts.length; i++) {
    const changes =
      (results[i] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
    if (changes !== 1) {
      throw new Error(
        `stale: knowledge ${payload.from_ids[i]} version mismatch or already archived`,
      );
    }
  }
  const intoChanges =
    (results[results.length - 1] as { meta?: { changes?: number } } | undefined)?.meta
      ?.changes ?? 0;
  if (intoChanges !== 1) {
    throw new Error(`merge: into_id ${payload.into_id} not found or archived`);
  }
}
```

**Note on the merged_from JSON union SQL**：上面的 `json_group_array(... union all ...)` 是 SQLite-flavored；D1 支持 SQLite JSON1 extension。如果 D1 不支持 `union all` 在 `json_group_array` 内（极少数情况），降级为：先 SELECT existing merged_from，JS 端 concat，再 UPDATE。但建议先按上面写法跑，遇到 D1 报错再改。

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: PASS, 20 tests。**Caveat**：mock 的 first()/run() 不真跑 SQL，所以 union-all SQL pattern 测试不验语义；只验 binds 顺序 + 是否有 archive UPDATE 调用 + 是否有 into UPDATE 调用。如有兴趣加端到端 D1 真测，留 Sub 4 时跑。

- [ ] **Step 5: Commit**

```bash
git add workers/src/knowledge/proposals.ts workers/src/knowledge/proposals.test.ts
git commit -m "feat(knowledge): applyMerge (archive from + append merged_from)"
```

---

### Task 5: 扩展 `acceptProposal` switch + `markProposalStale` + Zod `'stale'` enum

**Files:**
- Modify: `workers/src/knowledge/proposals.ts`
- Modify: `workers/src/knowledge/proposals.test.ts`
- Modify: `src/core/schema/index.ts`
- Modify: `src/core/schema/schema.test.ts`

**Goal:** `acceptProposal` 现在 dispatch 4 类高阶 mutation。每类捕获 stale 错误 → 把 dreaming_proposal.status 设 'stale' + decided_at + 抛出 stale 错误（router 层映射 409）。`AcceptResult` discriminated union 加 4 个变体。

- [ ] **Step 1: Extend Zod enum + write failing schema test**

Edit `src/core/schema/index.ts:111-116`：

```ts
export const DreamingProposalInsert = g.DreamingProposalInsertGenerated.extend({
  kind: b.DreamingProposalKind,
  status: z.enum(['pending', 'accepted', 'dismissed', 'stale']).nullish(),
});
export const DreamingProposal = g.DreamingProposalSelectGenerated.extend({
  kind: b.DreamingProposalKind,
  status: z.enum(['pending', 'accepted', 'dismissed', 'stale']),
});
```

Edit `src/core/schema/schema.test.ts`：在 `describe` 内末尾加：

```ts
  it('DreamingProposal accepts status=stale', () => {
    const result = DreamingProposal.safeParse({
      id: 'p1',
      kind: 'knowledge',
      payload: '{}',
      reasoning: 'r',
      status: 'stale',
      proposed_at: 1700000000,
      decided_at: 1700001000,
    });
    expect(result.success).toBe(true);
  });
```

确保 import：`import { DreamingProposal } from './index';`（如未 import 加上）。

- [ ] **Step 2: Run tests to verify (schema test should pass after enum extension)**

```bash
pnpm test src/core/schema/schema.test.ts
```

Expected: PASS, 8 tests（7 既有 + 1 新）。

- [ ] **Step 3: Write failing tests for acceptProposal extension**

Edit `workers/src/knowledge/proposals.test.ts`，加：

```ts
describe('acceptProposal — high-tier mutations', () => {
  it('dispatches reparent and returns reparent_applied result', async () => {
    const proposal = {
      id: 'p_reparent',
      kind: 'knowledge',
      payload: JSON.stringify({
        mutation: 'reparent',
        node_id: 'k_node',
        new_parent_id: 'k_newparent',
        expected_version: 3,
      }),
      reasoning: 'AI thinks this node fits better under k_newparent',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db, calls } = makeMockDb({
      proposals: { p_reparent: proposal },
      knowledge: {
        k_newparent: { id: 'k_newparent', archived_at: null },
      },
    });
    const result = await acceptProposal(db, 'p_reparent');
    expect(result.kind).toBe('reparent_applied');
    expect(calls.some((c) => /update knowledge.*parent_id/is.test(c.sql))).toBe(true);
    expect(calls.some((c) => /update dreaming_proposal set status = \?/i.test(c.sql))).toBe(true);
  });

  it('dispatches archive and returns archive_applied result', async () => {
    const proposal = {
      id: 'p_arch',
      kind: 'knowledge',
      payload: JSON.stringify({
        mutation: 'archive',
        node_id: 'k_node',
        expected_version: 5,
      }),
      reasoning: 'unused',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db } = makeMockDb({
      proposals: { p_arch: proposal },
      knowledge: { k_node: { id: 'k_node', archived_at: null, version: 5 } },
    });
    const result = await acceptProposal(db, 'p_arch');
    expect(result.kind).toBe('archive_applied');
  });

  it('marks proposal stale on stale error and re-throws', async () => {
    const proposal = {
      id: 'p_stale',
      kind: 'knowledge',
      payload: JSON.stringify({
        mutation: 'archive',
        node_id: 'k_node',
        expected_version: 5,
      }),
      reasoning: 'r',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db, calls } = makeMockDb({
      proposals: { p_stale: proposal },
      knowledge: { k_node: { id: 'k_node', archived_at: null, version: 5 } },
      runZeroChangesFor: /update knowledge/i,
    });
    await expect(acceptProposal(db, 'p_stale')).rejects.toThrow(/stale/i);
    const staleUpdate = calls.find(
      (c) => /update dreaming_proposal/i.test(c.sql) && /stale/.test(c.binds[0] as string),
    );
    expect(staleUpdate).toBeDefined();
  });
});
```

- [ ] **Step 4: Run tests to verify failure**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: 3 new tests FAIL — `acceptProposal` 当前只支持 propose_new（throws 'PR A only supports propose_new accept'）。

- [ ] **Step 5: Implement `markProposalStale` + extend `acceptProposal`**

Edit `workers/src/knowledge/proposals.ts`，先扩 `AcceptResult` 类型（在 `applyArchive` 之前 or 同处）：

```ts
export type AcceptResult =
  | { kind: 'propose_new_applied'; new_node_id: string }
  | { kind: 'reparent_applied'; node_id: string; new_parent_id: string }
  | { kind: 'merge_applied'; into_id: string; archived_ids: string[] }
  | { kind: 'split_applied'; archived_id: string; new_node_ids: string[] }
  | { kind: 'archive_applied'; node_id: string };
```

加 helper：

```ts
async function markProposalStale(db: D1Database, proposalId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `update dreaming_proposal set status = ?, decided_at = ? where id = ? and status = 'pending'`,
    )
    .bind('stale', now, proposalId)
    .run();
}
```

把 `acceptProposal` 整体替换为：

```ts
export async function acceptProposal(
  db: D1Database,
  proposalId: string,
): Promise<AcceptResult> {
  const row = await db
    .prepare(
      `select id, kind, payload, reasoning, status, proposed_at, decided_at from dreaming_proposal where id = ?`,
    )
    .bind(proposalId)
    .first<DreamingProposalRow>();
  if (!row) {
    throw new Error(`proposal not found: ${proposalId}`);
  }
  if (row.status !== 'pending') {
    throw new Error(`proposal ${proposalId} is not pending (status=${row.status})`);
  }
  const payload = JSON.parse(row.payload) as KnowledgeMutationPayload;

  // propose_new keeps PR A's race-safe inline path (INSERT…SELECT…WHERE EXISTS gated on
  // proposal still pending). High-tier mutations dispatch to apply* functions; on stale
  // we mark the proposal stale and re-throw.
  switch (payload.mutation) {
    case 'propose_new':
      return await acceptProposeNew(db, proposalId, payload);
    case 'reparent':
      return await acceptHighTier(db, proposalId, async () => {
        await applyReparent(db, payload);
        return { kind: 'reparent_applied', node_id: payload.node_id, new_parent_id: payload.new_parent_id! };
      });
    case 'merge':
      return await acceptHighTier(db, proposalId, async () => {
        await applyMerge(db, payload);
        return {
          kind: 'merge_applied',
          into_id: payload.into_id,
          archived_ids: payload.from_ids,
        };
      });
    case 'split':
      return await acceptHighTier(db, proposalId, async () => {
        const newIds = await applySplit(db, payload);
        return {
          kind: 'split_applied',
          archived_id: payload.from_id,
          new_node_ids: newIds,
        };
      });
    case 'archive':
      return await acceptHighTier(db, proposalId, async () => {
        await applyArchive(db, payload);
        return { kind: 'archive_applied', node_id: payload.node_id };
      });
  }
}

async function acceptHighTier(
  db: D1Database,
  proposalId: string,
  apply: () => Promise<AcceptResult>,
): Promise<AcceptResult> {
  let result: AcceptResult;
  try {
    result = await apply();
  } catch (e) {
    const msg = (e as Error).message;
    if (/^stale/i.test(msg)) {
      await markProposalStale(db, proposalId);
    }
    throw e;
  }
  const now = Math.floor(Date.now() / 1000);
  const update = await db
    .prepare(
      `update dreaming_proposal set status = ?, decided_at = ? where id = ? and status = 'pending'`,
    )
    .bind('accepted', now, proposalId)
    .run();
  const changes = (update as { meta?: { changes?: number } }).meta?.changes;
  if (changes !== 1) {
    throw new Error(`proposal ${proposalId} was concurrently decided`);
  }
  return result;
}

// Extracted from previous acceptProposal body for propose_new path. Inline race-safe
// INSERT…SELECT…WHERE EXISTS preserves the autofix-bot's PR A pattern.
async function acceptProposeNew(
  db: D1Database,
  proposalId: string,
  payload: ProposeNewPayload,
): Promise<AcceptResult> {
  if (payload.parent_id === null) {
    throw new Error(
      'PR A: propose_new with parent_id=null (root creation) not supported; Phase 2 multi-domain will allow it',
    );
  }
  await assertParentExists(db, payload.parent_id);
  const newId = createId();
  const now = Math.floor(Date.now() / 1000);
  const conditionalInsert = db
    .prepare(
      `insert into knowledge (
        id, name, domain, parent_id, base_mastery, ai_delta_mastery,
        merged_from, proposed_by_ai, approval_status, created_at, updated_at, version
      )
      select ?, ?, NULL, ?, 0, 0, '[]', 1, 'approved', ?, ?, 0
      where exists (select 1 from dreaming_proposal where id = ? and status = 'pending')`,
    )
    .bind(newId, payload.name, payload.parent_id, now, now, proposalId);
  const guardedUpdate = db
    .prepare(
      `update dreaming_proposal set status = ?, decided_at = ? where id = ? and status = 'pending'`,
    )
    .bind('accepted', now, proposalId);
  const results = await db.batch([conditionalInsert, guardedUpdate]);
  const updateChanges = (results[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes;
  if (updateChanges !== 1) {
    throw new Error(`proposal ${proposalId} was concurrently decided`);
  }
  return { kind: 'propose_new_applied', new_node_id: newId };
}
```

注意：删除原 `acceptProposal` 完整实现 + 把内部代码提到 `acceptProposeNew`，这是 refactor 不是新功能。

- [ ] **Step 6: Run tests to verify pass**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: PASS, 23 tests（既有 16 + 4 high-tier dispatch + 3 stale path）。

- [ ] **Step 7: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 8: Commit**

```bash
git add workers/src/knowledge/proposals.ts workers/src/knowledge/proposals.test.ts src/core/schema/index.ts src/core/schema/schema.test.ts
git commit -m "feat(knowledge): acceptProposal dispatch 4 high-tier mutations + stale state"
```

---

### Task 6: Knowledge router stale → 409 mapping

**Files:**
- Modify: `workers/src/routes/knowledge.ts`
- Modify: `workers/src/routes/knowledge.test.ts`

**Goal:** POST /proposals/:id/decide 当 acceptProposal 抛 stale → 409 + `{error: 'stale'}` body。

- [ ] **Step 1: Write failing test**

Edit `workers/src/routes/knowledge.test.ts`，在 `describe('POST /api/knowledge/proposals/:id/decide', ...)` 内末尾加：

```ts
  it('returns 409 when underlying mutation is stale', async () => {
    const { Bindings } = mockEnv(
      [{ id: 'k_node', name: 'X', domain: null, parent_id: 'k_p1', archived_at: null, version: 5 }],
      [
        {
          id: 'p_stale',
          kind: 'knowledge',
          payload: JSON.stringify({
            mutation: 'archive',
            node_id: 'k_node',
            expected_version: 5,
          }),
          reasoning: 'r',
          status: 'pending',
          proposed_at: 1700000000,
          decided_at: null,
        },
      ],
    );
    // Force the UPDATE knowledge ... to return changes=0 to simulate stale.
    // Reuse the mockEnv pattern: extend mockEnv to accept staleSimulation flag.
    // For brevity: the existing `run: async () => ({ success: true })` returns no meta.changes,
    // so applyArchive will see changes=0 and throw 'stale'. The router should map → 409.
    const res = await knowledge.request(
      '/proposals/p_stale/decide',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'accept' }),
        headers: { 'content-type': 'application/json' },
      },
      { ...Bindings },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('stale');
  });
```

**Note**：现 mockEnv 的 `run: async () => ({ success: true })` 没设 meta.changes，所以 archive UPDATE 看到 changes=undefined → 我们的 `?? 0` 兜底为 0 → throw stale。这巧合让 test 不需要 mock 改动。但 acceptProposeNew 路径的 `db.batch` 也会拿不到 meta.changes —— 测过 PR A path 那条 test ('accepts a pending propose_new proposal') 现在为啥过的？因为那条 test 有专用的 mock with meta.changes=1。Recheck mock: PR A's `mockEnv` `run: async () => ({ success: true })` 实际不含 meta，所以对 high-tier path 自然 fail 出 stale —— 但 PR A 的 propose_new test 也用一样的 mock 却 pass，因为 `acceptProposeNew` 的 batch 用 `results[1]?.meta?.changes` —— 对，也是 undefined → !== 1 → 抛 'concurrently decided' …但 test 显示 PASS？

实际查代码：mock D1 `prepare(...).bind(...).run` 调用栈跟 batch（包了 run() 列表）差异看 `mockEnv` 实际写法。重看上面 PR A 落地 mock：

```ts
        run: async () => ({ success: true }),
```

只返 `{ success: true }`，无 meta。但 acceptProposal of propose_new path 有 batch — mock D1 batch 写法在 PR A test 怎么处理？

实际 test mock 写法（PR A merge 后 by autofix bot）：

```ts
  const db = {
    prepare,
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      const results: unknown[] = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
```

batch 调每个 stmt 的 run() 拿到 `{success: true}`（没 meta）。那 acceptProposeNew 的 `results[1]?.meta?.changes !== 1` 应该 throws —— 但 test 是 pass 的 ?!

让我再 debug。PR A 的 'accepts a pending propose_new proposal' test mock 是 `mockEnv` (knowledge router test) 还是 `makeMockDb` (proposals helper test)？两者 mock 不同。

router test 文件 mock 实际：[查 workers/src/routes/knowledge.test.ts:39] —— `run: async () => ({ success: true, meta: { changes: 1 } })`

OK router test 已显式返 meta.changes=1。所以这个 stale test 想用同一 mock 但需要 forced-zero option：

更新 mockEnv 加 option `forceZeroChangesOnUpdate`，类似 proposals.test.ts 的 `runZeroChangesFor`。在 `mockEnv(allRows, proposalRows)` 函数加第三参 `opts?: { forceZeroChangesOnUpdate?: RegExp }`。

修改 stale test 改成：

```ts
  it('returns 409 when underlying mutation is stale', async () => {
    const { Bindings } = mockEnv(
      [{ id: 'k_node', name: 'X', domain: null, parent_id: 'k_p1', archived_at: null, version: 5 }],
      [
        {
          id: 'p_stale',
          kind: 'knowledge',
          payload: JSON.stringify({
            mutation: 'archive',
            node_id: 'k_node',
            expected_version: 5,
          }),
          reasoning: 'r',
          status: 'pending',
          proposed_at: 1700000000,
          decided_at: null,
        },
      ],
      { forceZeroChangesOnUpdate: /update knowledge/i },
    );
    const res = await knowledge.request(
      '/proposals/p_stale/decide',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'accept' }),
        headers: { 'content-type': 'application/json' },
      },
      { ...Bindings },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('stale');
  });
```

并修改 `mockEnv` 接受第三个 `opts?: { forceZeroChangesOnUpdate?: RegExp }`，在 `run: async () => ...` 处：

```ts
        run: async () => {
          if (opts?.forceZeroChangesOnUpdate?.test(sql)) {
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm test workers/src/routes/knowledge.test.ts
```

Expected: 1 new test FAIL — router 当前 catch block 没 'stale' branch，错误以 500 落到 onError。

- [ ] **Step 3: Add stale branch to router catch**

Edit `workers/src/routes/knowledge.ts`，在 `knowledge.post('/proposals/:id/decide', ...)` 的 catch block 内（PR A 已有一系列 if-else 错误映射），在最后 `throw e;` 之前加：

```ts
    if (/^stale/i.test(msg)) {
      return c.json({ error: 'stale', message: msg }, 409);
    }
```

具体位置参考 PR A 现有顺序，stale 放在 `not.*pending` 之前或之后都行，只要在 `throw e;` 之前。

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test workers/src/routes/knowledge.test.ts
```

Expected: PASS, 6 tests（既有 5 + 新 1）。

- [ ] **Step 5: Commit**

```bash
git add workers/src/routes/knowledge.ts workers/src/routes/knowledge.test.ts
git commit -m "feat(worker): map stale mutation → 409 in /proposals/:id/decide"
```

---

### Task 7: `KnowledgeReviewTask` 注册到 registry

**Files:**
- Modify: `src/ai/registry.ts`

**Goal:** 注册 task def，`needsToolCall: true`，default sonnet。

- [ ] **Step 1: Add task def**

Edit `src/ai/registry.ts`，在 `KnowledgeProposeTask` entry 之后（`} satisfies` 之前）加：

```ts
  KnowledgeReviewTask: {
    kind: 'KnowledgeReviewTask',
    description: '看完整 tree + 最近 mistakes，提议任意 mutation（reparent/merge/split/archive/propose_new）让 tree 更合理',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    fallbackChain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 12, timeout: 120_000 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['write_proposal'],
    systemPrompt:
      '你是知识图谱维护助手。看完整 tree（含层级 / archived / merged_from）+ 最近的 mistake 数据，propose 让 tree 更合理的 mutation。可选 mutation：propose_new（加新子节点）/ reparent（移到别 parent 下）/ merge（合并冗余）/ split（拆解过粗）/ archive（archive 没用的）。每 propose 一条，调一次 write_proposal({mutation, payload, reasoning})。reasoning 必须具体（指向 mistake id 或 tree 结构）。不必凑数；如果 tree 已经合理，0 条也行。Phase 1a 单 domain wenyan：禁止 propose_new / reparent / split 把节点变 root（parent_id=null）。',
  },
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 3: Run runner.test.ts to verify TaskKind union still ok**

```bash
pnpm test workers/src/ai/runner.test.ts
```

Expected: PASS, 5 tests。

- [ ] **Step 4: Commit**

```bash
git add src/ai/registry.ts
git commit -m "feat(ai/registry): KnowledgeReviewTask def (streaming + write_proposal tool)"
```

---

### Task 8: `streamReviewTask` (workers/src/knowledge/review.ts)

**Files:**
- Create: `workers/src/knowledge/review.ts`
- Create: `workers/src/knowledge/review.test.ts`

**Goal:** `streamReviewTask(db, env, model?)` 构造 `write_proposal` 工具（每次 call 写一行 dreaming_proposal）+ 预读 tree + recent mistakes 当 prompt 输入 + 调 streamTask 返 streaming Response。

- [ ] **Step 1: Write failing test**

Create `workers/src/knowledge/review.test.ts`：

```ts
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { streamReviewTask } from './review';

function makeMockDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const knowledgeRows = [
    { id: 'k1', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null, version: 0 },
  ];
  const mistakeRows: Record<string, unknown>[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => null,
        all: async () => {
          if (/from knowledge/i.test(sql)) return { results: knowledgeRows };
          if (/from mistake/i.test(sql)) return { results: mistakeRows };
          return { results: [] };
        },
        run: async () => ({ success: true }),
      };
    },
  }));
  return {
    db: { prepare } as unknown as D1Database,
    calls,
  };
}

function makeV3Usage() {
  return {
    inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  };
}

describe('streamReviewTask', () => {
  it('returns a streaming Response and writes dreaming_proposal on tool call', async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'tc1',
              toolName: 'write_proposal',
              input: JSON.stringify({
                mutation: 'archive',
                payload: { mutation: 'archive', node_id: 'k1', expected_version: 0 },
                reasoning: 'k1 has no recent mistakes; safe to archive',
              }),
            });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage: makeV3Usage(),
            });
            controller.close();
          },
        }),
      }),
    });

    const { db, calls } = makeMockDb();
    const env = {
      DB: db,
      INTERNAL_TOKEN: 'test',
      ANTHROPIC_API_KEY: 'test',
    } as never;

    const response = await streamReviewTask({ env, model: mockModel });
    expect(response).toBeInstanceOf(Response);
    expect(response.body).toBeTruthy();

    // Drain stream so onStepFinish fires.
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Verify a dreaming_proposal insert was made by the tool execute.
    const insert = calls.find((c) => /insert into dreaming_proposal/i.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.binds[1]).toBe('knowledge'); // kind
  });

  it('returns streaming Response even with no recent mistakes (empty input)', async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't0' });
            controller.enqueue({ type: 'text-delta', id: 't0', delta: 'tree looks fine' });
            controller.enqueue({ type: 'text-end', id: 't0' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage: makeV3Usage(),
            });
            controller.close();
          },
        }),
      }),
    });

    const { db } = makeMockDb();
    const env = {
      DB: db,
      INTERNAL_TOKEN: 'test',
      ANTHROPIC_API_KEY: 'test',
    } as never;

    const response = await streamReviewTask({ env, model: mockModel });
    expect(response).toBeInstanceOf(Response);
    const reader = response.body!.getReader();
    let total = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += new TextDecoder().decode(value);
    }
    expect(total).toContain('tree looks fine');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm test workers/src/knowledge/review.test.ts
```

Expected: FAIL — module not found。

- [ ] **Step 3: Implement `streamReviewTask`**

Create `workers/src/knowledge/review.ts`：

```ts
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { D1Database } from '@cloudflare/workers-types';
import { streamTask } from '../ai/runner';
import {
  writeDreamingProposal,
  type KnowledgeMutationPayload,
} from './proposals';
import type { Bindings } from '../types';

interface KnowledgeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: number | null;
  version: number;
  merged_from: string;
}

interface MistakeRow {
  id: string;
  question_id: string;
  knowledge_ids: string;
  cause: string | null;
}

const RECENT_MISTAKES_LIMIT = 100;

/**
 * Builds the input payload (tree + recent mistakes) for KnowledgeReviewTask.
 * Pre-fetches both so the LLM has full context as input rather than via tool calls.
 */
async function buildReviewInput(db: D1Database) {
  const tree = await db
    .prepare(
      `select id, name, domain, parent_id, archived_at, version, merged_from from knowledge order by created_at`,
    )
    .all<KnowledgeNode>();
  const mistakes = await db
    .prepare(
      `select id, question_id, knowledge_ids, cause from mistake order by created_at desc limit ?`,
    )
    .bind(RECENT_MISTAKES_LIMIT)
    .all<MistakeRow>();
  return {
    tree: tree.results,
    recent_mistakes: mistakes.results,
  };
}

/**
 * Stream KnowledgeReviewTask with a single tool — write_proposal — that the LLM
 * calls once per mutation it wants to propose. Each call writes a dreaming_proposal
 * row with kind='knowledge' and status='pending'. Returns the streamText Response
 * (caller pipes to client).
 */
export async function streamReviewTask(ctx: {
  env: Bindings;
  model?: LanguageModel;
}): Promise<Response> {
  const input = await buildReviewInput(ctx.env.DB);
  return streamTask(
    'KnowledgeReviewTask',
    input,
    {
      env: ctx.env,
      model: ctx.model,
      tools: {
        write_proposal: {
          description:
            'Propose one knowledge tree mutation. Call once per mutation. payload.mutation distinguishes the kind (propose_new / reparent / merge / split / archive). reasoning must be concrete.',
          inputSchema: z.object({
            payload: z.unknown(),
            reasoning: z.string(),
          }),
          execute: async ({
            payload,
            reasoning,
          }: {
            payload: KnowledgeMutationPayload;
            reasoning: string;
          }) => {
            const id = await writeDreamingProposal(ctx.env.DB, { payload, reasoning });
            return { proposal_id: id };
          },
        },
      },
    },
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test workers/src/knowledge/review.test.ts
```

Expected: PASS, 2 tests。

- [ ] **Step 5: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 6: Commit**

```bash
git add workers/src/knowledge/review.ts workers/src/knowledge/review.test.ts
git commit -m "feat(knowledge): streamReviewTask (streaming + write_proposal tool)"
```

---

### Task 9: `POST /api/knowledge/review` endpoint mount

**Files:**
- Modify: `workers/src/routes/knowledge.ts`
- Modify: `workers/src/routes/knowledge.test.ts`

**Goal:** 加 POST /review handler 在 knowledge sub-router 上，调 `streamReviewTask` 返流式 Response。

- [ ] **Step 1: Write failing test**

Edit `workers/src/routes/knowledge.test.ts`，加（在 `describe('POST /api/knowledge/proposals/:id/decide', ...)` 之后）：

```ts
describe('POST /api/knowledge/review', () => {
  it('hits the wired handler (does not 404)', async () => {
    const { Bindings } = mockEnv(
      [{ id: 'k1', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null, version: 0 }],
      [],
    );
    // The route reads tree + mistakes via `from knowledge` / `from mistake`; mockEnv
    // must answer those. (See mock update in Step 3 for `from mistake` passthrough.)
    //
    // Real LLM call happens via streamReviewTask → streamTask → anthropic provider,
    // which in test env has no network. We don't inject a mock model here (router
    // doesn't expose that override). Deep streaming behavior is covered by
    // workers/src/knowledge/review.test.ts (Task 8) using MockLanguageModelV3.
    //
    // For the router test, we only assert: handler is mounted (not 404). The eventual
    // status may be 500 because the LLM call fails — that's fine, the handler ran.
    const res = await knowledge.request(
      '/review',
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      { ...Bindings },
    );
    expect(res.status).not.toBe(404);
  });
});
```

**Note**：实际跑 `streamReviewTask` 在 router test 里太复杂（要 mock LLM API + 注入 model）。本 task 测降级为：handler 已 wire（status != 404）。深度测留 `review.test.ts`（Task 8 已写，直接拿 model 注入）。

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm test workers/src/routes/knowledge.test.ts
```

Expected: 新 test FAIL — `/review` 路径 404。

- [ ] **Step 3: Implement `POST /review` + extend mockEnv for mistake table**

Edit `workers/src/routes/knowledge.ts`，在文件顶部 imports 加：

```ts
import { streamReviewTask } from '../knowledge/review';
```

在 `knowledge.post('/proposals/:id/decide', ...)` 之后加：

```ts
knowledge.post('/review', async (c) => {
  return streamReviewTask({ env: c.env });
});
```

Edit `workers/src/routes/knowledge.test.ts` 的 `mockEnv` 函数，让 `from mistake` 也返空 results。在 `prepare` 内的 `all: async () =>` 块加一条：

```ts
        all: async () => {
          if (/from knowledge/i.test(sql)) {
            return { results: Object.values(knowledgeTable) };
          }
          if (/from dreaming_proposal/i.test(sql)) {
            const statusFilter = /status = \?/.test(sql) ? (binds[binds.length - 1] as string) : null;
            const results = Object.values(proposalTable).filter(
              (r) => statusFilter === null || r.status === statusFilter,
            );
            return { results };
          }
          if (/from mistake/i.test(sql)) {
            return { results: [] };
          }
          return { results: [] };
        },
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test workers/src/routes/knowledge.test.ts
```

Expected: PASS, 7 tests。

**Caveat**：实际跑时 streamReviewTask 调 anthropic provider 会因无 API key 失败。Test 只验 route 已挂载 + handler 不 404；返码可能 500（无 model 但 test env），test 用 `not.toBe(404)` 兜底。

- [ ] **Step 5: Commit**

```bash
git add workers/src/routes/knowledge.ts workers/src/routes/knowledge.test.ts
git commit -m "feat(worker): POST /api/knowledge/review (streaming KnowledgeReviewTask)"
```

---

### Task 10: `/knowledge` UI — "AI review my tree" 按钮 + 流式展示

**Files:**
- Modify: `src/routes/knowledge.tsx`

**Goal:** 顶部加按钮，点击 → POST /api/knowledge/review，读流式 text 显示。完成时 invalidate `['knowledge-proposals']` 让 proposal 页刷新。

- [ ] **Step 1: Replace `KnowledgeTree` with extended version**

Read 现 `src/routes/knowledge.tsx`，把整个 `KnowledgeTree` export function 替换为：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface KnowledgeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: number | null;
  effective_domain: string | null;
}

async function fetchKnowledge(): Promise<{ rows: KnowledgeNode[] }> {
  const res = await fetch('/api/knowledge', {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`knowledge fetch failed: ${res.status}`);
  return (await res.json()) as { rows: KnowledgeNode[] };
}

async function* triggerReview(): AsyncGenerator<string, void, void> {
  const res = await fetch('/api/knowledge/review', {
    method: 'POST',
    headers: {
      'x-internal-token': INTERNAL_TOKEN,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok || !res.body) {
    throw new Error(`review failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      const tail = decoder.decode();
      if (tail) yield tail;
      return;
    }
    yield decoder.decode(value, { stream: true });
  }
}

export function KnowledgeTree() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['knowledge'],
    queryFn: fetchKnowledge,
  });
  const [reviewText, setReviewText] = useState('');
  const reviewMutation = useMutation({
    mutationFn: async () => {
      setReviewText('');
      let buf = '';
      for await (const chunk of triggerReview()) {
        buf += chunk;
        setReviewText(buf);
      }
      return buf;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-proposals'] });
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">/knowledge</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => reviewMutation.mutate()}
            disabled={reviewMutation.isPending}
            className="px-2 py-1 bg-slate-900 text-white text-sm rounded disabled:opacity-50"
          >
            {reviewMutation.isPending ? 'AI reviewing…' : 'AI review my tree'}
          </button>
          <button
            type="button"
            onClick={() => refetch()}
            className="px-2 py-1 bg-slate-200 text-sm rounded"
          >
            Refresh
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Knowledge tree (read-only). Effective domain inherited from parent chain. AI review
        triggers KnowledgeReviewTask, which writes proposals to{' '}
        <a href="/knowledge/proposals" className="underline">
          /knowledge/proposals
        </a>
        .
      </p>

      {reviewMutation.error && (
        <p className="text-sm text-red-600 mb-2">
          Review failed: {(reviewMutation.error as Error).message}
        </p>
      )}
      {(reviewMutation.isPending || reviewText) && (
        <pre className="bg-slate-50 border rounded p-3 text-xs whitespace-pre-wrap mb-4 max-h-64 overflow-auto">
          {reviewText || '(waiting for first chunk)'}
        </pre>
      )}

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {data && (
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left p-2">id</th>
              <th className="text-left p-2">name</th>
              <th className="text-left p-2">parent_id</th>
              <th className="text-left p-2">domain</th>
              <th className="text-left p-2">effective_domain</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-slate-500">
                  No knowledge nodes yet. POST /api/_/seed to seed wenyan top-level.
                </td>
              </tr>
            )}
            {data.rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2 font-mono text-[10px]">{r.id}</td>
                <td className="p-2">{r.name}</td>
                <td className="p-2 font-mono text-[10px] text-slate-500">{r.parent_id ?? '—'}</td>
                <td className="p-2 text-slate-500">{r.domain ?? '(inherit)'}</td>
                <td className="p-2">{r.effective_domain ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Verify typecheck + build**

```bash
pnpm typecheck
pnpm build
```

Expected: 0 error；build clean。

- [ ] **Step 3: Commit**

```bash
git add src/routes/knowledge.tsx
git commit -m "feat(client): /knowledge AI review button + streaming progress"
```

---

### Task 11: `/knowledge/proposals` UI — 全 5 类 mutation 支持

**Files:**
- Modify: `src/routes/knowledge-proposals.tsx`

**Goal:** Render payload preview for 5 类 mutation；enable approve 按钮 for all（不再只 propose_new）；显示 stale status warning + 触发 stale 时反馈。

- [ ] **Step 1: Replace KnowledgeProposals export with extended version**

Read 现 `src/routes/knowledge-proposals.tsx`，把整个 export function 替换为：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface ProposalRow {
  id: string;
  kind: string;
  payload: string;
  reasoning: string;
  status: string;
  proposed_at: number;
  decided_at: number | null;
}

type AnyMutation =
  | { mutation: 'propose_new'; name: string; parent_id: string | null }
  | { mutation: 'reparent'; node_id: string; new_parent_id: string | null; expected_version: number }
  | { mutation: 'merge'; from_ids: string[]; into_id: string; expected_versions: Record<string, number> }
  | { mutation: 'split'; from_id: string; into: Array<{ name: string; parent_id: string | null }>; expected_version: number }
  | { mutation: 'archive'; node_id: string; expected_version: number };

async function fetchProposals(): Promise<{ rows: ProposalRow[] }> {
  const res = await fetch('/api/knowledge/proposals?status=pending', {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`proposals fetch failed: ${res.status}`);
  return (await res.json()) as { rows: ProposalRow[] };
}

async function decide(id: string, decision: 'accept' | 'reject'): Promise<void> {
  const res = await fetch(`/api/knowledge/proposals/${id}/decide`, {
    method: 'POST',
    headers: {
      'x-internal-token': INTERNAL_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.status === 409 && body.error === 'stale') {
      throw new Error('STALE: knowledge changed since AI proposed this. Re-run AI review.');
    }
    throw new Error(body.message ?? `decide failed: ${res.status}`);
  }
}

function PayloadPreview({ p }: { p: AnyMutation }) {
  switch (p.mutation) {
    case 'propose_new':
      return (
        <span>
          new node <b>{p.name}</b> under <code>{p.parent_id ?? '(root)'}</code>
        </span>
      );
    case 'reparent':
      return (
        <span>
          move <code>{p.node_id}</code> → under <code>{p.new_parent_id ?? '(root, rejected)'}</code>{' '}
          <span className="text-slate-500">(v{p.expected_version})</span>
        </span>
      );
    case 'merge':
      return (
        <span>
          merge <code>[{p.from_ids.join(', ')}]</code> → into <code>{p.into_id}</code>
        </span>
      );
    case 'split':
      return (
        <span>
          split <code>{p.from_id}</code> →{' '}
          {p.into.map((c, i) => (
            <span key={i}>
              <b>{c.name}</b>(under <code>{c.parent_id ?? '(root)'}</code>)
              {i < p.into.length - 1 ? ', ' : ''}
            </span>
          ))}
        </span>
      );
    case 'archive':
      return (
        <span>
          archive <code>{p.node_id}</code>{' '}
          <span className="text-slate-500">(v{p.expected_version})</span>
        </span>
      );
  }
}

export function KnowledgeProposals() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['knowledge-proposals'],
    queryFn: fetchProposals,
  });
  const decideMutation = useMutation({
    mutationFn: (args: { id: string; decision: 'accept' | 'reject' }) =>
      decide(args.id, args.decision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-proposals'] });
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">/knowledge/proposals</h1>
        <button
          type="button"
          onClick={() => refetch()}
          className="px-2 py-1 bg-slate-200 text-sm rounded"
        >
          Refresh
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Pending knowledge mutations (5 kinds: propose_new / reparent / merge / split / archive).
        Approve to apply; reject to dismiss. Stale = tree changed since AI proposed; re-run AI
        review.
      </p>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {decideMutation.error && (
        <p className="text-sm text-amber-700 mb-2">
          {(decideMutation.error as Error).message}
        </p>
      )}
      {data && data.rows.length === 0 && (
        <p className="text-sm text-slate-500">No pending proposals.</p>
      )}
      {data && data.rows.map((r) => {
        let parsed: AnyMutation | null;
        try {
          parsed = JSON.parse(r.payload) as AnyMutation;
        } catch {
          parsed = null;
        }
        return (
          <div key={r.id} className="border rounded p-3 mb-3">
            <div className="text-xs text-slate-500 mb-1">
              {new Date(r.proposed_at * 1000).toLocaleString()}
            </div>
            <div className="text-sm font-mono mb-2">
              {parsed ? (
                <>
                  <span className="text-slate-700 mr-2">[{parsed.mutation}]</span>
                  <PayloadPreview p={parsed} />
                </>
              ) : (
                <span className="text-red-600">unparseable payload</span>
              )}
            </div>
            <div className="text-xs text-slate-700 mb-2">Why: {r.reasoning}</div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!parsed || decideMutation.isPending}
                onClick={() => decideMutation.mutate({ id: r.id, decision: 'accept' })}
                className="px-2 py-1 bg-emerald-600 text-white text-sm rounded disabled:opacity-50"
              >
                Accept
              </button>
              <button
                type="button"
                disabled={decideMutation.isPending}
                onClick={() => decideMutation.mutate({ id: r.id, decision: 'reject' })}
                className="px-2 py-1 bg-slate-200 text-sm rounded disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </main>
  );
}
```

- [ ] **Step 2: Verify typecheck + build**

```bash
pnpm typecheck
pnpm build
```

Expected: 0 error；build clean。

- [ ] **Step 3: Commit**

```bash
git add src/routes/knowledge-proposals.tsx
git commit -m "feat(client): /knowledge/proposals support all 5 mutation kinds + stale 409 handling"
```

---

### Task 12: 最终验收 — typecheck + test + build

**Files:** 无修改（仅验证）

- [ ] **Step 1: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error。

- [ ] **Step 2: 全套 test**

```bash
pnpm test
```

Expected: 全部 pass。新增测预估：
- `workers/src/knowledge/proposals.test.ts`：+15 tests（4 reparent + 2 archive + 3 split + 4 merge + 3 high-tier dispatch + 1 ProposeNewPayload edge case unchanged）→ 7 既有 + ~14 新 ≈ 21
- `workers/src/knowledge/review.test.ts`：2 tests（新文件）
- `workers/src/routes/knowledge.test.ts`：+2 tests（stale 409 + review route mounted）→ 5 既有 + 2 新 = 7
- `src/core/schema/schema.test.ts`：+1 test（stale enum）→ 7 既有 + 1 新 = 8

PR A merge 后基线 ~54 tests；PR B 应 ~73 tests pass。

- [ ] **Step 3: build**

```bash
pnpm build
```

Expected: clean，PWA SW 重新生成。

- [ ] **Step 4: 手 smoke (optional)**

```bash
pnpm exec wrangler dev --config workers/wrangler.toml --local --persist-to .wrangler-state &
WRANGLER_PID=$!
sleep 8
TOKEN=$(grep '^INTERNAL_TOKEN=' workers/.dev.vars 2>/dev/null | cut -d= -f2-)
ANTHROPIC_KEY=$(grep '^ANTHROPIC_API_KEY=' workers/.dev.vars 2>/dev/null | cut -d= -f2-)

echo '=== ensure DB seeded ==='
pnpm exec wrangler d1 migrations apply DB --local --config workers/wrangler.toml
curl -s -X POST -H "x-internal-token: $TOKEN" 'http://localhost:8787/api/_/seed'
echo

echo '=== trigger review (will hit anthropic — real LLM call) ==='
curl -s -X POST -H "x-internal-token: $TOKEN" 'http://localhost:8787/api/knowledge/review' | head -c 1000
echo

echo '=== check proposals ==='
curl -s -H "x-internal-token: $TOKEN" 'http://localhost:8787/api/knowledge/proposals' | head -c 500
echo

kill $WRANGLER_PID 2>/dev/null
sleep 2
```

Expected：
- 第一次 review 因 tree 几乎空（仅 7 seed），LLM 应 propose 较少 mutation（可能 0-3 条）
- proposals 列出 pending 的（如果有）
- 如 ANTHROPIC_API_KEY 没设，review endpoint 会 fail 5xx — 跳过 smoke 是 OK 的，单测已覆盖核心路径

---

## Context

- 工作目录：`/Users/yukoval/yukoval-projects/the-learning-project/`
- 当前分支：`phase1a-sub1-pr-b`（基于 main 创建，含 PR A 已 merge 的 commit eb23b49）
- TDD 全程；Mock D1 helper 已有 + 加 `runZeroChangesFor` / `forceZeroChangesOnUpdate` option
- 4 类 apply 函数 race-safe pattern：UPDATE/INSERT WHERE version=expected_version AND archived_at IS NULL；changes!=1 → throw stale
- KnowledgeReviewTask 的 inputSchema for `write_proposal` tool 用 `z.unknown()` for payload（`KnowledgeMutationPayload` discriminated union 在 zod 表达较绕，自用工具+server-side validation 在 acceptProposal 时再严格 enforce 即可）
- spec § 3.3 "merge 把 mistake/question.knowledge_ids 重挂到 into_id" 本 plan **不实施**（标 deviation；理由 = SQLite JSON in-place 改写复杂 + 保留审计 trail）

## Before You Begin

- 如果 Task 4 `applyMerge` 的 SQL `union all + json_group_array` 在 D1 不支持（极少数情况），降级方案见 task body 末。
- 如果 Task 9 router test 因 streamReviewTask 实际调 anthropic API 失败而 status=500，test 用 `not.toBe(404)` 兜底，符合 "test handler is wired"。深度测放 review.test.ts。
- 现有 PR A 测的 mock 简单时省略了 `archived_at` 字段；Task 1 收紧 `assertParentExists` 后这些 mock 行需补 `archived_at: null`（已在 Task 1 caveat 说明）。

## Your Job

1. Tasks 1-12 顺序执行（顺序 important — Task 5 dispatch switch 依赖 Task 1-4 的 apply 函数；Task 9 review endpoint 依赖 Task 8 streamReviewTask；Task 6 stale 409 依赖 Task 5 status='stale' 写入）
2. 不动 PR A 已 ship 的核心代码逻辑（仅 inline 收紧 `assertParentExists`，重构 `acceptProposal` switch 不算破坏 — 把原 propose_new path 提到 `acceptProposeNew` 函数内）
3. UI 不强求美观（Tailwind 简陋同 inspect.tsx 风格）

## Report Format

每个 Task 完成时报：
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- 文件改动摘要（新建 / 修改）
- TDD 关键 step 输出（fail + pass）
- typecheck / test / build 输出（如适用）
- Commit SHA

最后 Task 12 报全套验收数据。

---

## Troubleshooting

**Q: drizzle-zod auto-derive 让 `DreamingProposal` Zod 跟 schema 同步，但 schema 里 status 是 free `text`，怎么 narrow 到 enum 含 'stale'？**

A: `src/core/schema/index.ts` 用 `.extend()` override status 字段为 z.enum(...) — drizzle-zod 不约束这点。Task 5 直接改 `.extend()` 内 enum 即可。

**Q: 现有 PR A `acceptProposal` 内联 propose_new 实现，Task 5 把它提取到 `acceptProposeNew` 是否破坏？**

A: 行为不变，只是 code organization。原 PR A test ('accepts a pending propose_new proposal') 仍 pass，因为 dispatch switch case 'propose_new' 调 `acceptProposeNew` 拿到同样 result。

**Q: applyMerge 的 SQLite union all in json_group_array 不工作**

A: D1 SQLite 标准 JSON1 应支持。如不支持，降级 read-modify-write：先 SELECT into.merged_from，JS concat with from_ids，UPDATE set merged_from=?。Task 4 末尾备注。

**Q: Task 9 router test 实际 streamReviewTask 调 anthropic 报错怎么测？**

A: 这是 known limitation —— router test 仅验 handler 已 wire（不 404）；深度 streamReviewTask 测在 Task 8 review.test.ts 用 MockLanguageModelV3 注入。

**Q: TanStack Query useMutation 与 async generator 配合？**

A: Task 10 `triggerReview` 是 async generator；`mutationFn` 包它的 for-await 循环 + 把 chunks 累加到 state。setState 在 mutationFn 内调，TanStack v5 不阻挡。

---

## Open（实施时再决）

- 是否在 PR B 末尾给 split / merge 加批量 mistake/question.knowledge_ids 重挂工具？目前的 deviation 让 merged/split 后旧 mistake 仍指向 archived 节点，read-side 跟 merged_from 跳转。如果实际跑下来 archived 引用累积让 UI 不 friendly，followup PR 加。
- KnowledgeReviewTask budget.maxIterations=12 估的是 "tree 7 节点 + recent 100 mistake 应能 propose ≤ 10 mutation"。如实际跑超出，改大或加 stopWhen 自定义。
- 跨 domain reparent warning ("将影响 N 条 mistake") UI 在 PR B 不实现 — Phase 1a 单 domain 不会触发。Phase 2 多 domain 时加。
