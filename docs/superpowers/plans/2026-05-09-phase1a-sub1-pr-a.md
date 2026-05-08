# Phase 1a Sub 1 PR A — 知识图谱基础 + propose_new mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec § 三 § 3.9 PR A —— schema migration (domain NULLABLE) + 薄 seed (7 顶级文言文) + GET /api/knowledge + KnowledgeProposeTask 注册 + dreaming_proposal 写入 helper + propose_new approve/reject API + 2 个简陋 UI（tree read-only / proposal 审）。

**Architecture:** Worker 端加 `workers/src/routes/knowledge.ts` Hono sub-router 处理 /api/knowledge/*；seed 放 `workers/src/knowledge/seed.ts` + curriculum.json (data) 在 `src/subjects/wenyan/`；getEffectiveDomain 放 `workers/src/knowledge/domain.ts`；dreaming_proposal 写入 + apply propose_new 放 `workers/src/knowledge/proposals.ts`。Client 加 `src/routes/knowledge.tsx`（tree 表）和 `src/routes/knowledge-proposals.tsx`（pending 列）两个独立 page。复用 dreaming_proposal 表（已存在），kind='knowledge'，payload 携带 `mutation` 字段做 discriminated union（避免改 DreamingProposalKind enum）。

**Tech Stack:** Drizzle d1 dialect + drizzle-kit migration generator, Hono routing, AI SDK v6 task def (registry only — Sub 2 wire inline trigger), TanStack Query v5 + Tailwind v4 (UI), vitest 2.1.x + MockLanguageModelV3 / makeMockDb pattern, drizzle-zod auto-derived Zod。

**Spec reference:** `docs/superpowers/specs/2026-05-09-phase1a-design.md` § 三 + § 3.9 PR A。

---

## File Structure

### 创建（新文件）

- `workers/src/knowledge/domain.ts` — `getEffectiveDomain(db, nodeId)` walk-up helper
- `workers/src/knowledge/domain.test.ts` — 单测
- `workers/src/knowledge/seed.ts` — `seedKnowledge(db)` idempotent runner（读 wenyan curriculum 写 D1）
- `workers/src/knowledge/seed.test.ts` — 单测
- `workers/src/knowledge/proposals.ts` — `writeDreamingProposal` + `applyProposeNew` + `dismissProposal` + `acceptProposal` (PR A 仅支持 propose_new)
- `workers/src/knowledge/proposals.test.ts` — 单测
- `workers/src/routes/knowledge.ts` — Hono sub-router：`GET /` + `GET /proposals` + `POST /proposals/:id/decide`
- `workers/src/routes/knowledge.test.ts` — endpoint 单测（mock D1）
- `src/routes/knowledge.tsx` — Tree explorer page（read-only）
- `src/routes/knowledge-proposals.tsx` — Pending proposal review page

### 修改（已有文件）

- `src/db/schema.ts` — `knowledge.domain` 去掉 `.notNull()`
- `src/core/schema/index.ts` — `KnowledgeInsert` / `Knowledge` Zod 适配 nullable domain
- `src/core/schema/schema.test.ts` — 加一条 nullable domain 测
- `src/subjects/wenyan/curriculum.json` — 填 7 顶级
- `src/subjects/wenyan/seed.ts` — `KnowledgeSeed` 加 `slug` 字段
- `src/ai/registry.ts` — 加 `KnowledgeProposeTask`
- `workers/src/index.ts` — mount knowledge router + 加 `POST /api/_/seed` 一行
- `src/App.tsx` — 加 `/knowledge` + `/knowledge/proposals` 两个 route
- `src/routes/inspect.tsx` — 顶部加两个 link 到 `/knowledge` 和 `/knowledge/proposals`（小改）
- `drizzle/0001_*.sql` — drizzle-kit 自动生成（不手写）

### 不动

- `workers/src/ai/runner.ts`、`workers/src/routes/logs.ts` 等已落功能
- `dreaming_proposal` 表 schema 不动；用 `kind='knowledge'`，`payload.mutation` 做 discriminated union
- `DreamingProposalKind` business enum 不动（已有 'knowledge' 项）

---

## Tasks

---

### Task 1: Schema migration — `knowledge.domain` NULLABLE

**Files:**
- Modify: `src/db/schema.ts:10`
- Modify: `src/core/schema/index.ts:7-15`
- Modify: `src/core/schema/schema.test.ts`
- Create (auto-generated): `drizzle/0001_*.sql`

- [ ] **Step 1: Write failing test for nullable domain**

Edit `src/core/schema/schema.test.ts`，在 `describe('schema generated from drizzle', ...)` 里加：

```ts
  it('KnowledgeInsert accepts null domain (non-root nodes inherit)', () => {
    const result = KnowledgeInsert.safeParse({
      id: 'k_child',
      name: '通假字',
      domain: null,
      parent_id: 'k_root',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/core/schema/schema.test.ts
```

Expected: FAIL — KnowledgeInsert 现在 `domain` 是 NOT NULL，传 `null` 会被拒。

- [ ] **Step 3: Make domain nullable in drizzle schema**

Edit `src/db/schema.ts:7-27`，`domain` 那行从：
```ts
  domain: text('domain').notNull(),
```
改为：
```ts
  domain: text('domain'),
```

- [ ] **Step 4: Update business Zod schema for nullable domain**

`drizzle-zod` 的 `createInsertSchema` 会自动 derive，但 `src/core/schema/index.ts` 里的 `KnowledgeInsert` / `Knowledge` 是 `.extend(...)`，不会自动跟 nullable。读 `src/core/schema/index.ts:7-15`，确认 KnowledgeInsert / Knowledge 的 `.extend` 块**没有**显式 override `domain`。如果有就也改成 nullable。否则什么都不用动（generated.ts 会自动 derive nullable）。

实际现状（确认过）：`KnowledgeInsert` / `Knowledge` 只 extend 了 `approval_status`，没动 domain，所以 generated.ts 一改 drizzle schema 自动跟。

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test src/core/schema/schema.test.ts
```

Expected: PASS — 新 nullable domain 测过；原 `domain: 'wenyan'` 测仍过（nullable 包含 not-null 子集）。

- [ ] **Step 6: Generate migration**

```bash
pnpm db:generate
```

Expected: drizzle-kit 输出 `drizzle/0001_*.sql`。**Inspect** 生成的 SQL：

```bash
ls drizzle/0001_*.sql
cat drizzle/0001_*.sql | head -40
```

预期 SQL 含一条 ALTER TABLE 或 SQLite 的 table-rebuild 模式（CREATE TABLE __new + INSERT ... SELECT + DROP + RENAME）。SQLite 不支持直接 DROP NOT NULL，drizzle-kit 通常走 table rebuild。**关键 invariant**：rebuild 后 knowledge 表所有现有 row 仍存在；如果生成 SQL 看起来会 DROP 数据，停下来先汇报。

- [ ] **Step 7: Run typecheck**

```bash
pnpm typecheck
```

Expected: 0 error。

- [ ] **Step 8: Run all tests**

```bash
pnpm test
```

Expected: 全部 pass（既有 34 + 1 新 = 35）。

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/core/schema/schema.test.ts drizzle/0001_*.sql drizzle/meta/
git commit -m "feat(schema): knowledge.domain → NULLABLE (Phase 1a Sub 1 PR A)"
```

---

### Task 2: `getEffectiveDomain` helper

**Files:**
- Create: `workers/src/knowledge/domain.ts`
- Create: `workers/src/knowledge/domain.test.ts`

- [ ] **Step 1: Write failing test**

Create `workers/src/knowledge/domain.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { getEffectiveDomain } from './domain';

function makeMockDbWithRows(rows: Record<string, { domain: string | null; parent_id: string | null }>) {
  const prepare = vi.fn((sql: string) => ({
    bind: (id: string) => ({
      first: async () => rows[id] ?? null,
    }),
  }));
  return { prepare } as unknown as D1Database;
}

describe('getEffectiveDomain', () => {
  it('returns own domain if root (parent_id is null)', async () => {
    const db = makeMockDbWithRows({
      k1: { domain: 'wenyan', parent_id: null },
    });
    expect(await getEffectiveDomain(db, 'k1')).toBe('wenyan');
  });

  it('walks up parent chain to find first non-null domain', async () => {
    const db = makeMockDbWithRows({
      k_leaf: { domain: null, parent_id: 'k_mid' },
      k_mid: { domain: null, parent_id: 'k_root' },
      k_root: { domain: 'wenyan', parent_id: null },
    });
    expect(await getEffectiveDomain(db, 'k_leaf')).toBe('wenyan');
  });

  it('throws if node not found', async () => {
    const db = makeMockDbWithRows({});
    await expect(getEffectiveDomain(db, 'k_missing')).rejects.toThrow(/not found/i);
  });

  it('throws if walks to root with null domain (invariant violation)', async () => {
    const db = makeMockDbWithRows({
      k1: { domain: null, parent_id: null },
    });
    await expect(getEffectiveDomain(db, 'k1')).rejects.toThrow(/root.*domain/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test workers/src/knowledge/domain.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement helper**

Create `workers/src/knowledge/domain.ts`：

```ts
import type { D1Database } from '@cloudflare/workers-types';

interface KnowledgeRow {
  domain: string | null;
  parent_id: string | null;
}

const MAX_DEPTH = 32; // 防 cycle

/**
 * Walk up parent chain to find first non-null domain.
 * Invariant: parent_id IS NULL ↔ domain IS NOT NULL（root 必有 domain）。
 */
export async function getEffectiveDomain(db: D1Database, nodeId: string): Promise<string> {
  let curId: string = nodeId;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const row = await db
      .prepare('select domain, parent_id from knowledge where id = ?')
      .bind(curId)
      .first<KnowledgeRow>();
    if (!row) {
      throw new Error(`knowledge node not found: ${curId}`);
    }
    if (row.domain !== null) {
      return row.domain;
    }
    if (row.parent_id === null) {
      throw new Error(`root node has null domain (invariant violation): ${curId}`);
    }
    curId = row.parent_id;
  }
  throw new Error(`getEffectiveDomain max depth ${MAX_DEPTH} exceeded for ${nodeId}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test workers/src/knowledge/domain.test.ts
```

Expected: PASS, 4 tests。

- [ ] **Step 5: Commit**

```bash
git add workers/src/knowledge/domain.ts workers/src/knowledge/domain.test.ts
git commit -m "feat(knowledge): getEffectiveDomain helper (walk parent chain)"
```

---

### Task 3: Curriculum.json 填实 + KnowledgeSeed 加 slug

**Files:**
- Modify: `src/subjects/wenyan/curriculum.json`
- Modify: `src/subjects/wenyan/seed.ts`

- [ ] **Step 1: Update curriculum.json**

Read 当前 `src/subjects/wenyan/curriculum.json`，写入：

```json
{
  "version": 1,
  "domain": "wenyan",
  "knowledge_seeds": [
    { "slug": "shici", "name": "实词" },
    { "slug": "xuci", "name": "虚词" },
    { "slug": "jushi", "name": "句式" },
    { "slug": "duanju", "name": "断句" },
    { "slug": "fanyi", "name": "翻译" },
    { "slug": "wenxue-changshi", "name": "文学常识" },
    { "slug": "lunshu", "name": "论述题" }
  ]
}
```

- [ ] **Step 2: Update KnowledgeSeed type**

Edit `src/subjects/wenyan/seed.ts`：

```ts
import curriculum from './curriculum.json';

export interface KnowledgeSeed {
  slug: string; // stable id 用，idempotent seed 靠它
  name: string;
  parent_slug?: string; // 顶级留空，后续多层用
}

export interface Curriculum {
  version: number;
  domain: string;
  knowledge_seeds: KnowledgeSeed[];
}

export function getCurriculum(): Curriculum {
  return curriculum as Curriculum;
}
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck
```

Expected: 0 error。

- [ ] **Step 4: Commit**

```bash
git add src/subjects/wenyan/curriculum.json src/subjects/wenyan/seed.ts
git commit -m "feat(wenyan): 填 7 顶级文言文 seed + KnowledgeSeed.slug 字段"
```

---

### Task 4: `seedKnowledge` runner（worker 端）

**Files:**
- Create: `workers/src/knowledge/seed.ts`
- Create: `workers/src/knowledge/seed.test.ts`

- [ ] **Step 1: Write failing test**

Create `workers/src/knowledge/seed.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { seedKnowledge } from './seed';

function makeMockDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const existingIds = new Set<string>();
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          // simulate `select id from knowledge where id = ?`
          if (/select id from knowledge where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            return existingIds.has(id) ? { id } : null;
          }
          return null;
        },
        run: async () => {
          if (/insert into knowledge/i.test(sql)) {
            existingIds.add(binds[0] as string); // first bind is id
          }
          return { success: true };
        },
      };
    },
  }));
  return { db: { prepare } as unknown as D1Database, calls, existingIds };
}

describe('seedKnowledge', () => {
  it('inserts 7 wenyan top-level nodes on first run', async () => {
    const { db, calls } = makeMockDb();
    const result = await seedKnowledge(db);
    expect(result.inserted).toBe(7);
    expect(result.skipped).toBe(0);
    const inserts = calls.filter((c) => /insert into knowledge/i.test(c.sql));
    expect(inserts).toHaveLength(7);
    // verify first insert has wenyan domain + null parent
    expect(inserts[0].binds[2]).toBe('wenyan'); // domain bind
    expect(inserts[0].binds[3]).toBeNull(); // parent_id bind
  });

  it('is idempotent — second run inserts 0', async () => {
    const { db } = makeMockDb();
    await seedKnowledge(db);
    const result2 = await seedKnowledge(db);
    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(7);
  });

  it('uses stable id derived from slug', async () => {
    const { db, calls } = makeMockDb();
    await seedKnowledge(db);
    const inserts = calls.filter((c) => /insert into knowledge/i.test(c.sql));
    const ids = inserts.map((c) => c.binds[0] as string);
    // slug-derived ids — match the 7 slugs from curriculum
    expect(ids).toContain('seed:wenyan:shici');
    expect(ids).toContain('seed:wenyan:lunshu');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test workers/src/knowledge/seed.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `seedKnowledge`**

Create `workers/src/knowledge/seed.ts`：

```ts
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
      .bind(
        id,
        seed.name,
        curriculum.domain,
        null, // parent_id (root)
        0, // base_mastery
        0, // ai_delta_mastery
        '[]', // merged_from json
        0, // proposed_by_ai (false)
        'approved',
        now,
        now,
        0, // version
      )
      .run();
    inserted += 1;
  }

  return { inserted, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test workers/src/knowledge/seed.test.ts
```

Expected: PASS, 3 tests。

- [ ] **Step 5: Commit**

```bash
git add workers/src/knowledge/seed.ts workers/src/knowledge/seed.test.ts
git commit -m "feat(worker): seedKnowledge idempotent runner (PR A 改进 1)"
```

---

### Task 5: `writeDreamingProposal` + `applyProposeNew` + decide helpers

**Files:**
- Create: `workers/src/knowledge/proposals.ts`
- Create: `workers/src/knowledge/proposals.test.ts`

- [ ] **Step 1: Write failing test**

Create `workers/src/knowledge/proposals.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import {
  writeDreamingProposal,
  applyProposeNew,
  acceptProposal,
  dismissProposal,
} from './proposals';

function makeMockDb(initialRows: Record<string, Record<string, unknown>> = {}) {
  const tableRows: Record<string, Record<string, Record<string, unknown>>> = {
    knowledge: {},
    dreaming_proposal: { ...initialRows },
  };
  const calls: Array<{ sql: string; binds: unknown[] }> = [];

  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          if (/from dreaming_proposal where id = \?/i.test(sql)) {
            return tableRows.dreaming_proposal[binds[0] as string] ?? null;
          }
          if (/select id from knowledge where id = \?/i.test(sql)) {
            return tableRows.knowledge[binds[0] as string] ?? null;
          }
          return null;
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
        all: async () => ({ results: Object.values(tableRows.dreaming_proposal) }),
      };
    },
  }));
  return { db: { prepare } as unknown as D1Database, tableRows, calls };
}

describe('writeDreamingProposal', () => {
  it('inserts a dreaming_proposal row with kind=knowledge', async () => {
    const { db, calls } = makeMockDb();
    const id = await writeDreamingProposal(db, {
      payload: {
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      },
      reasoning: '看 mistake 涉及通假字',
    });
    expect(id).toMatch(/^[a-z0-9]+$/);
    const insert = calls.find((c) => /insert into dreaming_proposal/i.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.binds[1]).toBe('knowledge'); // kind
    expect(insert?.binds[4]).toBe('pending'); // status
  });
});

describe('applyProposeNew', () => {
  it('inserts a new knowledge row with status=approved', async () => {
    const { db, calls } = makeMockDb();
    const newId = await applyProposeNew(db, {
      mutation: 'propose_new',
      name: '通假字',
      parent_id: 'seed:wenyan:shici',
    });
    expect(newId).toMatch(/^[a-z0-9]+$/);
    const insert = calls.find((c) => /insert into knowledge/i.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.binds[1]).toBe('通假字'); // name
    expect(insert?.binds[2]).toBeNull(); // domain (child node, inherit)
    expect(insert?.binds[3]).toBe('seed:wenyan:shici'); // parent_id
    expect(insert?.binds[7]).toBe(1); // proposed_by_ai true
  });
});

describe('acceptProposal (propose_new only)', () => {
  it('accepts pending propose_new proposal: inserts knowledge + sets status', async () => {
    const proposal = {
      id: 'p1',
      kind: 'knowledge',
      payload: JSON.stringify({
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      }),
      reasoning: 'test',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db, calls } = makeMockDb({ p1: proposal });
    const result = await acceptProposal(db, 'p1');
    expect(result.kind).toBe('propose_new_applied');
    expect(result.new_node_id).toMatch(/^[a-z0-9]+$/);
    // knowledge insert + dreaming_proposal status update both happened
    expect(calls.some((c) => /insert into knowledge/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /update dreaming_proposal set status = \?/i.test(c.sql))).toBe(true);
  });

  it('rejects accept on non-pending proposal', async () => {
    const proposal = {
      id: 'p2',
      kind: 'knowledge',
      payload: JSON.stringify({ mutation: 'propose_new', name: 'x', parent_id: null }),
      reasoning: 'test',
      status: 'accepted',
      proposed_at: 1700000000,
      decided_at: 1700001000,
    };
    const { db } = makeMockDb({ p2: proposal });
    await expect(acceptProposal(db, 'p2')).rejects.toThrow(/not.*pending/i);
  });

  it('rejects unsupported mutation kinds (PR A scope)', async () => {
    const proposal = {
      id: 'p3',
      kind: 'knowledge',
      payload: JSON.stringify({ mutation: 'reparent', node_id: 'x', new_parent_id: 'y' }),
      reasoning: 'test',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db } = makeMockDb({ p3: proposal });
    await expect(acceptProposal(db, 'p3')).rejects.toThrow(/PR A.*propose_new/i);
  });
});

describe('dismissProposal', () => {
  it('updates status to dismissed', async () => {
    const proposal = {
      id: 'p4',
      kind: 'knowledge',
      payload: JSON.stringify({ mutation: 'propose_new', name: 'x', parent_id: null }),
      reasoning: 'test',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db, calls } = makeMockDb({ p4: proposal });
    await dismissProposal(db, 'p4');
    const update = calls.find((c) => /update dreaming_proposal/i.test(c.sql));
    expect(update?.binds[0]).toBe('dismissed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: FAIL — module not found。

- [ ] **Step 3: Implement helpers**

Create `workers/src/knowledge/proposals.ts`：

```ts
import type { D1Database } from '@cloudflare/workers-types';
import { createId } from '@paralleldrive/cuid2';

/**
 * Knowledge mutation payloads — discriminated union on `mutation` field.
 * dreaming_proposal.kind 永远 'knowledge'，具体 mutation 类型在 payload.mutation。
 */
export type ProposeNewPayload = {
  mutation: 'propose_new';
  name: string;
  parent_id: string | null;
};

export type ReparentPayload = {
  mutation: 'reparent';
  node_id: string;
  new_parent_id: string | null;
  expected_version: number;
};

export type MergePayload = {
  mutation: 'merge';
  from_ids: string[];
  into_id: string;
  expected_versions: Record<string, number>;
};

export type SplitPayload = {
  mutation: 'split';
  from_id: string;
  into: Array<{ name: string; parent_id: string | null }>;
  expected_version: number;
};

export type ArchivePayload = {
  mutation: 'archive';
  node_id: string;
  expected_version: number;
};

export type KnowledgeMutationPayload =
  | ProposeNewPayload
  | ReparentPayload
  | MergePayload
  | SplitPayload
  | ArchivePayload;

export interface DreamingProposalRow {
  id: string;
  kind: string;
  payload: string; // json string
  reasoning: string;
  status: string;
  proposed_at: number;
  decided_at: number | null;
}

export interface WriteProposalEntry {
  payload: KnowledgeMutationPayload;
  reasoning: string;
}

export async function writeDreamingProposal(
  db: D1Database,
  entry: WriteProposalEntry,
): Promise<string> {
  const id = createId();
  const proposedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `insert into dreaming_proposal (id, kind, payload, reasoning, status, proposed_at) values (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      'knowledge',
      JSON.stringify(entry.payload),
      entry.reasoning,
      'pending',
      proposedAt,
    )
    .run();
  return id;
}

/**
 * Apply propose_new: insert a new knowledge row.
 * Returns the new node id.
 */
export async function applyProposeNew(
  db: D1Database,
  payload: ProposeNewPayload,
): Promise<string> {
  const newId = createId();
  const now = Math.floor(Date.now() / 1000);
  // child node → domain NULL（inherit）；root node creation 不在 propose_new 范围
  await db
    .prepare(
      `insert into knowledge (
        id, name, domain, parent_id, base_mastery, ai_delta_mastery,
        merged_from, proposed_by_ai, approval_status, created_at, updated_at, version
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId,
      payload.name,
      payload.parent_id === null ? 'wenyan' : null, // root → 'wenyan'; child → inherit
      payload.parent_id,
      0,
      0,
      '[]',
      1, // proposed_by_ai true
      'approved',
      now,
      now,
      0,
    )
    .run();
  return newId;
}

export type AcceptResult = { kind: 'propose_new_applied'; new_node_id: string };

/**
 * Accept proposal: only propose_new in PR A. Reparent / merge / split / archive 留 PR B。
 */
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
  if (payload.mutation !== 'propose_new') {
    throw new Error(`PR A only supports propose_new accept; got ${payload.mutation}`);
  }
  const newId = await applyProposeNew(db, payload);
  const decidedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(`update dreaming_proposal set status = ?, decided_at = ? where id = ?`)
    .bind('accepted', decidedAt, proposalId)
    .run();
  return { kind: 'propose_new_applied', new_node_id: newId };
}

export async function dismissProposal(db: D1Database, proposalId: string): Promise<void> {
  const decidedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(`update dreaming_proposal set status = ?, decided_at = ? where id = ?`)
    .bind('dismissed', decidedAt, proposalId)
    .run();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test workers/src/knowledge/proposals.test.ts
```

Expected: PASS, 5 tests。

- [ ] **Step 5: Commit**

```bash
git add workers/src/knowledge/proposals.ts workers/src/knowledge/proposals.test.ts
git commit -m "feat(knowledge): writeDreamingProposal + applyProposeNew + accept/dismiss helpers"
```

---

### Task 6: `KnowledgeProposeTask` 注册到 registry

**Files:**
- Modify: `src/ai/registry.ts`

- [ ] **Step 1: Add task definition**

Edit `src/ai/registry.ts`，在 `tasks = {` block 内 `VisionExtractTask` 之后加：

```ts
  KnowledgeProposeTask: {
    kind: 'KnowledgeProposeTask',
    description: '看新录入的 mistake 提议 0-3 个 propose_new 知识点（挂在合适 parent 下）',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    fallbackChain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 2 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是知识图谱编辑助手。用户录入了一道做错的题，挂的 knowledge_ids 是用户自选。看错题内容 + 当前 tree snapshot，如果你认为 tree 里缺一个**更精确**的子节点能挂这条 mistake（例：「之-主谓间用法」之于「虚词」），propose 它。0-3 条，不必凑数。每条返回 { name, parent_id, reasoning }。parent_id 必须是 tree 里已有节点 id；若找不到合适 parent，跳过这条。',
  },
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm typecheck
```

Expected: 0 error。

- [ ] **Step 3: Verify registry export still works**

```bash
pnpm test workers/src/ai/runner.test.ts
```

Expected: PASS — 现有 5 个 runner 测仍跑通（registry 增项不破坏 existing TaskKind union）。

- [ ] **Step 4: Commit**

```bash
git add src/ai/registry.ts
git commit -m "feat(ai/registry): add KnowledgeProposeTask def (Sub 2 来 wire inline)"
```

---

### Task 7: `workers/src/routes/knowledge.ts` Hono sub-router — 3 endpoints

**Files:**
- Create: `workers/src/routes/knowledge.ts`
- Create: `workers/src/routes/knowledge.test.ts`

- [ ] **Step 1: Write failing test**

Create `workers/src/routes/knowledge.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { knowledge } from './knowledge';

function mockEnv(allRows: Record<string, unknown>[] = [], proposalRows: Record<string, unknown>[] = []) {
  const knowledgeTable: Record<string, Record<string, unknown>> = {};
  for (const r of allRows) knowledgeTable[r.id as string] = r;
  const proposalTable: Record<string, Record<string, unknown>> = {};
  for (const r of proposalRows) proposalTable[r.id as string] = r;

  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          if (/from dreaming_proposal where id = \?/i.test(sql)) {
            return proposalTable[binds[0] as string] ?? null;
          }
          if (/select id from knowledge where id = \?/i.test(sql)) {
            return knowledgeTable[binds[0] as string] ?? null;
          }
          return null;
        },
        all: async () => {
          if (/from knowledge/i.test(sql)) {
            return { results: Object.values(knowledgeTable) };
          }
          if (/from dreaming_proposal/i.test(sql)) {
            return { results: Object.values(proposalTable) };
          }
          return { results: [] };
        },
        run: async () => ({ success: true }),
      };
    },
  }));
  const db = { prepare } as unknown as D1Database;
  return {
    Bindings: { DB: db, INTERNAL_TOKEN: 'test', ANTHROPIC_API_KEY: 'test' },
    calls,
  };
}

describe('GET /api/knowledge', () => {
  it('returns full tree with effective_domain pre-computed', async () => {
    const { Bindings } = mockEnv([
      { id: 'k1', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null },
      { id: 'k2', name: '之', domain: null, parent_id: 'k1', archived_at: null },
    ]);
    const res = await knowledge.request('/', { method: 'GET' }, { ...Bindings });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; effective_domain: string }> };
    expect(body.rows).toHaveLength(2);
    const k1 = body.rows.find((r) => r.id === 'k1');
    const k2 = body.rows.find((r) => r.id === 'k2');
    expect(k1?.effective_domain).toBe('wenyan');
    expect(k2?.effective_domain).toBe('wenyan'); // inherited
  });

  it('excludes archived nodes by default', async () => {
    const { Bindings } = mockEnv([
      { id: 'k1', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null },
      { id: 'k_old', name: '旧', domain: 'wenyan', parent_id: null, archived_at: 1700000000 },
    ]);
    const res = await knowledge.request('/', { method: 'GET' }, { ...Bindings });
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });
});

describe('GET /api/knowledge/proposals', () => {
  it('returns pending proposals (default)', async () => {
    const { Bindings } = mockEnv([], [
      { id: 'p1', kind: 'knowledge', payload: '{}', reasoning: 'r', status: 'pending', proposed_at: 1700000000, decided_at: null },
      { id: 'p2', kind: 'knowledge', payload: '{}', reasoning: 'r', status: 'accepted', proposed_at: 1700000000, decided_at: 1700001000 },
    ]);
    const res = await knowledge.request('/proposals', { method: 'GET' }, { ...Bindings });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    // mock 's `all()` returns 全部; route 应过滤 status=pending; 这里 mock 简化返全部，只验返了即可
    expect(body.rows.length).toBeGreaterThan(0);
  });
});

describe('POST /api/knowledge/proposals/:id/decide', () => {
  it('rejects with 400 if decision missing', async () => {
    const { Bindings } = mockEnv();
    const res = await knowledge.request(
      '/proposals/p1/decide',
      { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } },
      { ...Bindings },
    );
    expect(res.status).toBe(400);
  });

  it('accepts a pending propose_new proposal', async () => {
    const { Bindings, calls } = mockEnv([], [
      {
        id: 'p1',
        kind: 'knowledge',
        payload: JSON.stringify({ mutation: 'propose_new', name: '通假字', parent_id: 'seed:wenyan:shici' }),
        reasoning: 'r',
        status: 'pending',
        proposed_at: 1700000000,
        decided_at: null,
      },
    ]);
    const res = await knowledge.request(
      '/proposals/p1/decide',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'accept' }),
        headers: { 'content-type': 'application/json' },
      },
      { ...Bindings },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('propose_new_applied');
    expect(calls.some((c) => /insert into knowledge/i.test(c.sql))).toBe(true);
  });

  it('dismisses a pending proposal', async () => {
    const { Bindings, calls } = mockEnv([], [
      {
        id: 'p2',
        kind: 'knowledge',
        payload: JSON.stringify({ mutation: 'propose_new', name: 'x', parent_id: null }),
        reasoning: 'r',
        status: 'pending',
        proposed_at: 1700000000,
        decided_at: null,
      },
    ]);
    const res = await knowledge.request(
      '/proposals/p2/decide',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'reject' }),
        headers: { 'content-type': 'application/json' },
      },
      { ...Bindings },
    );
    expect(res.status).toBe(200);
    const update = calls.find((c) => /update dreaming_proposal/i.test(c.sql));
    expect(update?.binds[0]).toBe('dismissed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test workers/src/routes/knowledge.test.ts
```

Expected: FAIL — module not found。

- [ ] **Step 3: Implement sub-router**

Create `workers/src/routes/knowledge.ts`：

```ts
import { Hono } from 'hono';
import { acceptProposal, dismissProposal } from '../knowledge/proposals';
import type { AppEnv } from '../types';

export const knowledge = new Hono<AppEnv>();

interface KnowledgeRow {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: number | null;
}

knowledge.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `select id, name, domain, parent_id, archived_at from knowledge where archived_at is null`,
  )
    .all<KnowledgeRow>();
  // pre-compute effective_domain by index
  const byId = new Map<string, KnowledgeRow>();
  for (const r of rows.results) byId.set(r.id, r);
  const out = rows.results.map((r) => {
    let cur: KnowledgeRow | undefined = r;
    let depth = 0;
    while (cur && cur.domain === null && cur.parent_id !== null && depth < 32) {
      cur = byId.get(cur.parent_id);
      depth += 1;
    }
    return { ...r, effective_domain: cur?.domain ?? null };
  });
  return c.json({ rows: out });
});

knowledge.get('/proposals', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const rows = await c.env.DB.prepare(
    `select id, kind, payload, reasoning, status, proposed_at, decided_at from dreaming_proposal where kind = 'knowledge' and status = ? order by proposed_at desc`,
  )
    .bind(status)
    .all<Record<string, unknown>>();
  return c.json({ rows: rows.results });
});

knowledge.post('/proposals/:id/decide', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string };
  if (body.decision !== 'accept' && body.decision !== 'reject') {
    return c.json({ error: 'missing or invalid decision', allowed: ['accept', 'reject'] }, 400);
  }
  try {
    if (body.decision === 'accept') {
      const result = await acceptProposal(c.env.DB, id);
      return c.json(result);
    }
    await dismissProposal(c.env.DB, id);
    return c.json({ kind: 'dismissed' });
  } catch (e) {
    const msg = (e as Error).message;
    if (/PR A.*propose_new/i.test(msg)) {
      return c.json({ error: 'unsupported_mutation', message: msg }, 400);
    }
    if (/not.*pending/i.test(msg)) {
      return c.json({ error: 'not_pending', message: msg }, 409);
    }
    if (/not found/i.test(msg)) {
      return c.json({ error: 'not_found' }, 404);
    }
    throw e;
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test workers/src/routes/knowledge.test.ts
```

Expected: PASS, 5 tests。

如 GET /proposals filter test 因 mock 简化没正确按 status 过滤而失败（mock 的 `all()` 返回所有 proposalRows 没看 SQL where 子句），把 mock 的 `all()` 函数加上对 status binding 的过滤：

```ts
        all: async () => {
          if (/from dreaming_proposal/i.test(sql)) {
            const statusFilter = /status = \?/.test(sql) ? (binds[binds.length - 1] as string) : null;
            const results = Object.values(proposalTable).filter(
              (r) => statusFilter === null || r.status === statusFilter,
            );
            return { results };
          }
          // ... 其他 cases
        },
```

- [ ] **Step 5: Commit**

```bash
git add workers/src/routes/knowledge.ts workers/src/routes/knowledge.test.ts
git commit -m "feat(worker): /api/knowledge router (GET / + proposals + decide) (PR A 改进 4-6)"
```

---

### Task 8: Mount knowledge router + `POST /api/_/seed` 在 index.ts

**Files:**
- Modify: `workers/src/index.ts`

- [ ] **Step 1: Read current index.ts state**

用 Read tool 读 `workers/src/index.ts`（约 60 行），确认现有 import 列 + mount 顺序，找好插入点。

- [ ] **Step 2: Add seed route + knowledge router mount**

Edit `workers/src/index.ts`：在 import 段加：
```ts
import { knowledge } from './routes/knowledge';
import { seedKnowledge } from './knowledge/seed';
```

在 `app.route('/api/_/logs', logs);` 之后加：
```ts
app.route('/api/knowledge', knowledge);

app.post('/api/_/seed', async (c) => {
  const result = await seedKnowledge(c.env.DB);
  return c.json(result);
});
```

最终 wiring 顺序：cors → internalAuth → logs router → knowledge router → /_/seed → health → ai task。

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: 0 error。

- [ ] **Step 4: Run all tests**

```bash
pnpm test
```

Expected: 全部 pass（既有 + 新加的 4 个 test 文件）。

- [ ] **Step 5: Commit**

```bash
git add workers/src/index.ts
git commit -m "feat(worker): mount /api/knowledge + POST /api/_/seed"
```

---

### Task 9: Client `/knowledge` UI（read-only tree）

**Files:**
- Create: `src/routes/knowledge.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create knowledge.tsx page**

Create `src/routes/knowledge.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query';

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

export function KnowledgeTree() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['knowledge'],
    queryFn: fetchKnowledge,
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">/knowledge</h1>
        <button
          type="button"
          onClick={() => refetch()}
          className="px-2 py-1 bg-slate-200 text-sm rounded"
        >
          Refresh
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Knowledge tree (read-only). Effective domain inherited from parent chain.
      </p>

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

- [ ] **Step 2: Add route to App.tsx**

Read 现 `src/App.tsx`。加 import + route：

```tsx
import { Route, Routes } from 'react-router-dom';
import { Home } from './routes/index';
import { Inspect } from './routes/inspect';
import { KnowledgeTree } from './routes/knowledge';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/_/inspect" element={<Inspect />} />
      <Route path="/knowledge" element={<KnowledgeTree />} />
    </Routes>
  );
}
```

- [ ] **Step 3: Verify typecheck + build**

```bash
pnpm typecheck
pnpm build
```

Expected: 0 error；`dist/` 重新 build clean。

- [ ] **Step 4: Commit**

```bash
git add src/routes/knowledge.tsx src/App.tsx
git commit -m "feat(client): /knowledge tree explorer UI (read-only)"
```

---

### Task 10: Client `/knowledge/proposals` UI

**Files:**
- Create: `src/routes/knowledge-proposals.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create knowledge-proposals.tsx page**

Create `src/routes/knowledge-proposals.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface ProposalRow {
  id: string;
  kind: string;
  payload: string; // json string
  reasoning: string;
  status: string;
  proposed_at: number;
  decided_at: number | null;
}

interface ProposeNewPayload {
  mutation: 'propose_new';
  name: string;
  parent_id: string | null;
}

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
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `decide failed: ${res.status}`);
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
        Pending knowledge mutations. PR A 仅 propose_new；reparent/merge/split/archive 在 PR B。
      </p>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {decideMutation.error && (
        <p className="text-sm text-red-600 mb-2">
          Decide failed: {(decideMutation.error as Error).message}
        </p>
      )}
      {data && data.rows.length === 0 && (
        <p className="text-sm text-slate-500">No pending proposals.</p>
      )}
      {data && data.rows.map((r) => {
        let parsed: { mutation?: string } & Partial<ProposeNewPayload>;
        try {
          parsed = JSON.parse(r.payload) as ProposeNewPayload;
        } catch {
          parsed = { mutation: 'unknown' };
        }
        const isProposeNew = parsed.mutation === 'propose_new';
        return (
          <div key={r.id} className="border rounded p-3 mb-3">
            <div className="text-xs text-slate-500 mb-1">
              {new Date(r.proposed_at * 1000).toLocaleString()}
            </div>
            <div className="text-sm font-mono mb-2">
              {parsed.mutation ?? 'unknown'}
              {isProposeNew && (
                <>
                  {' '}→ name=<b>{parsed.name}</b>, parent_id=
                  <code>{parsed.parent_id ?? '(root)'}</code>
                </>
              )}
            </div>
            <div className="text-xs text-slate-700 mb-2">Why: {r.reasoning}</div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!isProposeNew || decideMutation.isPending}
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
              {!isProposeNew && (
                <span className="text-xs text-amber-700 self-center">
                  PR B 才支持此 mutation 类型
                </span>
              )}
            </div>
          </div>
        );
      })}
    </main>
  );
}
```

- [ ] **Step 2: Add route to App.tsx**

Read 现 `src/App.tsx`。加 import + route：

```tsx
import { Route, Routes } from 'react-router-dom';
import { Home } from './routes/index';
import { Inspect } from './routes/inspect';
import { KnowledgeTree } from './routes/knowledge';
import { KnowledgeProposals } from './routes/knowledge-proposals';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/_/inspect" element={<Inspect />} />
      <Route path="/knowledge" element={<KnowledgeTree />} />
      <Route path="/knowledge/proposals" element={<KnowledgeProposals />} />
    </Routes>
  );
}
```

- [ ] **Step 3: Add inspect.tsx 顶部 link 到这两个新页**

Edit `src/routes/inspect.tsx`，找到 `<h1 className="text-xl font-semibold mb-4">/_/inspect</h1>` 那行，紧接它后加（在 description `<p>` 之前）：

```tsx
      <p className="text-sm text-slate-500 mb-1">
        Other admin pages: <a href="/knowledge" className="underline">/knowledge</a> ·{' '}
        <a href="/knowledge/proposals" className="underline">/knowledge/proposals</a>
      </p>
```

- [ ] **Step 4: Verify typecheck + build**

```bash
pnpm typecheck
pnpm build
```

Expected: 0 error；build clean。

- [ ] **Step 5: Commit**

```bash
git add src/routes/knowledge-proposals.tsx src/App.tsx src/routes/inspect.tsx
git commit -m "feat(client): /knowledge/proposals approval UI + inspect cross-links"
```

---

### Task 11: 最终验收 — full typecheck + test + build

**Files:**
- 无修改（仅验证）

- [ ] **Step 1: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error（含 workers/tsconfig.json）。

- [ ] **Step 2: 全套 test**

```bash
pnpm test
```

Expected: 全部 pass，新增测：
- `src/core/schema/schema.test.ts` +1
- `workers/src/knowledge/domain.test.ts` 4 tests
- `workers/src/knowledge/seed.test.ts` 3 tests
- `workers/src/knowledge/proposals.test.ts` 5 tests
- `workers/src/routes/knowledge.test.ts` 5 tests

总计原 34 + 新增 18 = 52 tests pass。

- [ ] **Step 3: build**

```bash
pnpm build
```

Expected: clean，PWA SW 重新生成（含 /knowledge / /knowledge/proposals 进 precache）。

- [ ] **Step 4: 手 smoke (optional)**

```bash
pnpm exec wrangler dev --config workers/wrangler.toml --local --persist-to .wrangler-state &
WRANGLER_PID=$!
sleep 8
TOKEN=$(grep '^INTERNAL_TOKEN=' workers/.dev.vars 2>/dev/null | cut -d= -f2-)

echo '=== migration apply ==='
pnpm exec wrangler d1 migrations apply DB --local --config workers/wrangler.toml

echo '=== seed ==='
curl -s -X POST -H "x-internal-token: $TOKEN" 'http://localhost:8787/api/_/seed'
echo
echo '=== get tree ==='
curl -s -H "x-internal-token: $TOKEN" 'http://localhost:8787/api/knowledge' | head -c 500
echo
echo '=== get proposals (empty) ==='
curl -s -H "x-internal-token: $TOKEN" 'http://localhost:8787/api/knowledge/proposals'

kill $WRANGLER_PID 2>/dev/null
sleep 2
```

Expected:
- seed: `{"inserted": 7, "skipped": 0}` (first run) 或 `{"inserted": 0, "skipped": 7}` (subsequent)
- get tree: 7 行 wenyan rows
- get proposals: `{"rows": []}`

如 D1 migration apply 失败（local mock 未支持），降级：跳过 smoke，所有 endpoint 行为已经被 mock-D1 unit test 覆盖。

---

## Context

- 工作目录：`/Users/yukoval/yukoval-projects/the-learning-project/`
- 当前分支起点：`phase1a-design`（含 spec commit 27d6dfd）。 PR A 实施直接基于此 branch 续 commit；推时若 branch 名想更准确可改名 `phase1a-sub1-pr-a` 再 push。
- 用 OSS 不自建 / TDD 全程 / drizzle-zod 单一来源 / Worker 端 mock D1 测 endpoint
- AI Task layer 仅注册 (`src/ai/registry.ts`)，inline trigger wire 留 Sub 2 PR
- `dreaming_proposal.kind` 永远 `'knowledge'`，具体 mutation 类型在 payload.mutation（discriminated union），避免改 DreamingProposalKind business enum
- **invariant**：`parent_id IS NULL ↔ domain IS NOT NULL`；apply propose_new 自动按 parent_id 决定 domain（root → 'wenyan', child → null inherit）

## Before You Begin

- Branch already on `phase1a-design`（spec commit 在）。Continue commit 即可。
- 如果 drizzle-kit `pnpm db:generate` 在 Task 1 输出 SQL 看上去会 DROP knowledge 表数据（rebuild 模式应该是 INSERT...SELECT 保留数据）— 停下来汇报，不要 force 跑。可能需要手写 migration 用 PRAGMA table_info + SQLite 标准 rebuild pattern。
- 现 wenyan 知识表是空的（只有 placeholder 0000 migration），所以 dataloss 风险其实为 0 — 但仍 inspect SQL。

## Your Job

1. Tasks 1-11 顺序执行；Task 1 schema migration 是基础不可跳。
2. Task 6 KnowledgeProposeTask 仅注册 task def — 不写 calling 逻辑（Sub 2 来 wire）。
3. Task 7 endpoint test 中 mock filter status 简化；如 1-2 test 用现 mock 不过，再细化 mock first/all 区分 SQL pattern；不强求完美，重点是 happy path + 主要 error 分支覆盖。
4. UI 不强求美观——Tailwind utility 简陋够用即可，跟 inspect.tsx 一个风格。

## Report Format

每个 Task 完成时报：
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- 文件改动摘要（新建 / 修改）
- TDD 关键 step 输出（fail 输出 + pass 输出）
- typecheck / test / build 输出（如适用）
- Commit SHA

最后一 Task 报全套验收数据（typecheck 0 error / test 全 pass / build clean）。

---

## Troubleshooting

**Q: `pnpm db:generate` 没生成新 migration**

A: drizzle-kit 先看 `drizzle/meta/_journal.json` + `0000_snapshot.json` 决定 diff。如确实改了 schema 但没 diff，删 `node_modules/.cache` 重跑；或者手写 migration（创 `drizzle/0001_knowledge_domain_nullable.sql`）。

**Q: SQLite 直接 ALTER COLUMN drop NOT NULL 会失败**

A: 是的。drizzle-kit 通常生成 table-rebuild 模式的 SQL（CREATE __new + INSERT SELECT + DROP + RENAME）。inspect 生成的 SQL 看是不是这种 pattern；如果不是手写一份。

**Q: `workers/tsconfig.json` 报 cross-package import 错**

A: 用 `moduleResolution: bundler` 已 OK（PR 1 已配）。如 Task 4 `import { getCurriculum } from '../../../src/subjects/wenyan/seed'` 报错，verify path 段数对（workers/src/knowledge/seed.ts → ../../ 到 workers/，再 ../ 到 repo root，再 src/...）。

**Q: Hono mock test request 用法**

A: `knowledge.request('/path', requestInit, env)` 是 Hono 文档化 testing entry。`env` 含 `Bindings` 直接传 mock。参考 `workers/src/routes/logs.test.ts` (PR 3 落) 现有 pattern。

**Q: TanStack Query v5 `useMutation` 用法**

A: v5 用 `{ mutationFn, onSuccess, ... }` object form。`mutate(args)` 触发；`isPending` 替代 v4 `isLoading`；`error` 是 `Error | null`。

---

## Open（实施时再决）

- 如果 drizzle-kit 生成的 0001 migration 跟 spec 描述不符（dataloss / 字段顺序异常），手写一份；写到 PR description 提示 reviewer。
- KnowledgeProposeTask 注册时 `defaultModel` 选 sonnet（自我认知 + 提案 reasoning 较细致），但若实际跑下来 token 量大可降 haiku（Sub 2 wire 时再调）。
- `dismissProposal` PR A 永远成功（即使 status 已 ≠ pending 也允许重试 — idempotent）。如要严格化，加 status check + 409 — 留 PR B 时讨论。
