# YUK-15 — record → proposal evidence loop 接通 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/record` 条目能浮现为 proposal 的 evidence_ref（producer 引用 record id），并在 proposal inbox 卡片 + 新建的 record 详情页之间形成双向 backlink；producer accept proposal 时把对应 record `processing_status` 从 `raw` 标到 `actioned`。

**Architecture:** 走现有 `learning_record.processing_status` 枚举（`raw → actioned`，不新加 column）；inbox `GenericProposalCard` 扩 `record` kind evidence_ref 渲染；新建 `app/(app)/records/[id]/page.tsx` 详情页 + `GET /api/records/[id]/proposals` 反查 producer。Producer 已经有写 `evidence_refs[].kind='record'` 的 schema 支持（[`src/core/schema/proposal.ts:20`](../../../src/core/schema/proposal.ts:20)），本 lane 只在 accept 路径补 record `processing_status` flip。

**Tech Stack:** Drizzle (`learning_record`) / Next App Router / TanStack Query / Zod / Vitest（DB tier）/ 现有 `src/server/records/queries.ts` + `src/server/proposals/actions.ts` + `src/server/proposals/inbox.ts`

**Lane meta:**
- Linear: [YUK-15](https://linear.app/yukoval-studios/issue/YUK-15) (5pts, M1, High)
- Wave: W2，chain-merge 位置 #2（YUK-14 之后）
- Git branch: `yukovaldakia09/yuk-15-record-proposal-evidence-loop-接通`
- Parent outline: [`2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) §M1.3
- Cross-cutting helper：**CC-4 Proposal lifecycle**（accept 路径走 owner-service rate event；evidence_refs 走 `ProposalEvidenceRef` schema 现有 `record` kind）

**Pre-flight (lane 启动当天，按顺序跑完才动代码)：**
1. `git fetch origin main && git rebase origin/main` —— 同步 W1 chain-merge 结果（特别是 YUK-13 design doc，避免内容冲突）
2. 重读 [`src/server/proposals/actions.ts`](../../../src/server/proposals/actions.ts) accept 函数完整体（本 plan 只能假设其结构，启动当天确认未被 W1 改）
3. 确认 [`src/core/schema/proposal.ts:20`](../../../src/core/schema/proposal.ts:20) `ProposalEvidenceRef` 包含 `'record'` kind
4. `lsof -nP -iTCP:3000` —— 释放 OrbStack 容器占的端口（CLAUDE.md `feedback_dev_server_port_check`）
5. 跑一遍 baseline：`pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile`

---

## File Structure

**Modify:**
- `src/server/proposals/actions.ts` —— accept 路径加 record processing_status flip
- `src/server/proposals/actions.test.ts`（或新建对应 test 文件）—— 覆盖 flip 行为
- `src/server/records/queries.ts` —— 加 `markRecordsActioned(db, recordIds)` helper
- `src/server/records/queries.test.ts` —— helper unit test（DB tier）
- `app/(app)/inbox/page.tsx` `GenericProposalCard` —— `record` kind evidence_ref 渲染为 chip 链接
- `app/api/records/[id]/route.ts` —— GET 返回值带 derived `proposals_referenced` 计数（轻量），完整查询走新端点

**Create:**
- `app/api/records/[id]/proposals/route.ts` —— `GET` 返回该 record 被引用过的 proposal 列表（inbox row 形态）
- `app/api/records/[id]/proposals/route.test.ts`
- `app/(app)/records/[id]/page.tsx` —— record 详情页（含已产生 proposal 列表）

**No changes:**
- `src/core/schema/proposal.ts` —— `ProposalEvidenceRef` `record` kind 已有
- `src/db/schema.ts` —— `learning_record.processing_status` 枚举已有 `'actioned'`
- `src/server/proposals/writer.ts` —— producer 写 `evidence_refs` 已通过 schema 守
- `src/server/records/types.ts` —— 沿用现有 `UpdateLearningRecordPatch`

---

## Tasks

### Task 1: `markRecordsActioned` helper + DB test

**Files:**
- Modify: `src/server/records/queries.ts`
- Test: `src/server/records/queries.test.ts`

- [ ] **Step 1: Write failing DB test**

Append to `src/server/records/queries.test.ts`:

```ts
describe('markRecordsActioned', () => {
  it('flips matching records from raw to actioned and leaves others untouched', async () => {
    await withDb(async (db) => {
      const r1 = await createLearningRecord(db, { kind: 'mistake', content_md: 'a', source: 'user', capture_mode: 'manual', activity_kind: 'study', knowledge_ids: [], payload: {} });
      const r2 = await createLearningRecord(db, { kind: 'mistake', content_md: 'b', source: 'user', capture_mode: 'manual', activity_kind: 'study', knowledge_ids: [], payload: {} });
      const r3 = await createLearningRecord(db, { kind: 'mistake', content_md: 'c', source: 'user', capture_mode: 'manual', activity_kind: 'study', knowledge_ids: [], payload: {} });

      const flipped = await markRecordsActioned(db, [r1.record.id, r3.record.id]);
      expect(flipped).toEqual(expect.arrayContaining([r1.record.id, r3.record.id]));

      const rows = await listLearningRecords(db, { limit: 10 });
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(r1.record.id)?.processing_status).toBe('actioned');
      expect(byId.get(r2.record.id)?.processing_status).toBe('raw');
      expect(byId.get(r3.record.id)?.processing_status).toBe('actioned');
    });
  });

  it('is idempotent — already-actioned records stay actioned', async () => {
    await withDb(async (db) => {
      const r = await createLearningRecord(db, { kind: 'mistake', content_md: 'x', source: 'user', capture_mode: 'manual', activity_kind: 'study', knowledge_ids: [], payload: {}, processing_status: 'actioned' });
      const flipped = await markRecordsActioned(db, [r.record.id]);
      expect(flipped).toEqual([]);
    });
  });

  it('returns [] for empty input without hitting DB', async () => {
    await withDb(async (db) => {
      const flipped = await markRecordsActioned(db, []);
      expect(flipped).toEqual([]);
    });
  });
});
```

Add `markRecordsActioned` to the existing import from `./queries`.

- [ ] **Step 2: Run test, expect fail**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/records/queries.test.ts -t 'markRecordsActioned'
```

Expected: FAIL — `markRecordsActioned is not a function`.

- [ ] **Step 3: Implement helper**

Append to `src/server/records/queries.ts` (after `updateLearningRecord`):

```ts
/**
 * Flip a batch of learning_record rows from `raw` to `actioned`.
 * Used by proposal accept path when a producer's proposal cites these
 * records via evidence_refs. Idempotent: rows already at `actioned` or
 * `archived` are skipped. Returns the IDs actually flipped.
 */
export async function markRecordsActioned(db: DbLike, recordIds: string[]): Promise<string[]> {
  if (recordIds.length === 0) return [];
  const uniqueIds = [...new Set(recordIds)];
  const rows = await db
    .update(learning_record)
    .set({ processing_status: 'actioned', updated_at: new Date() })
    .where(and(inArray(learning_record.id, uniqueIds), eq(learning_record.processing_status, 'raw')))
    .returning({ id: learning_record.id });
  return rows.map((r) => r.id);
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/records/queries.test.ts -t 'markRecordsActioned'
```

Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/server/records/queries.ts src/server/records/queries.test.ts
git commit -m "feat(records): add markRecordsActioned helper for YUK-15"
```

---

### Task 2: Wire `markRecordsActioned` into proposal accept path

**Files:**
- Modify: `src/server/proposals/actions.ts`
- Test: `src/server/proposals/actions.test.ts` (or create if not exists)

- [ ] **Step 1: Locate accept path**

```bash
grep -n "acceptProposal\b\|export.*function.*accept" src/server/proposals/actions.ts
```

Identify the function that handles `POST /api/proposals/[id]/accept`. Note its signature and where it commits the rate event.

- [ ] **Step 2: Write failing test**

Append to `src/server/proposals/actions.test.ts`:

```ts
describe('accept proposal — record evidence flip', () => {
  it('flips learning_record processing_status raw → actioned for record evidence_refs', async () => {
    await withDb(async (db) => {
      const rec = await createLearningRecord(db, {
        kind: 'mistake', content_md: 'wrong answer recap', source: 'user',
        capture_mode: 'manual', activity_kind: 'study', knowledge_ids: [], payload: {},
      });
      const proposalId = await writeProposal(db, {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: 'root' },
        reason_md: 'derived from record',
        evidence_refs: [{ kind: 'record', id: rec.record.id }],
        proposed_change: { mutation: 'propose_new', name: 'New node', parent_id: 'root' },
      });

      await acceptProposal(db, { proposalId, actor: 'self' });

      const rows = await listLearningRecords(db, { limit: 10 });
      expect(rows.find((r) => r.id === rec.record.id)?.processing_status).toBe('actioned');
    });
  });

  it('leaves non-record evidence_refs alone', async () => {
    await withDb(async (db) => {
      const proposalId = await writeProposal(db, {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: 'root' },
        reason_md: 'derived from event only',
        evidence_refs: [{ kind: 'event', id: 'evt_xxx' }],
        proposed_change: { mutation: 'propose_new', name: 'New node 2', parent_id: 'root' },
      });
      await expect(acceptProposal(db, { proposalId, actor: 'self' })).resolves.not.toThrow();
    });
  });
});
```

Adjust imports / helper names to match existing test patterns in the same file. If `writeProposal` signature differs, use the actual writer.

- [ ] **Step 3: Run test, expect fail**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/proposals/actions.test.ts -t 'record evidence flip'
```

Expected: FAIL — record stays at `'raw'`.

- [ ] **Step 4: Implement in accept path**

In `src/server/proposals/actions.ts`, find the accept function. After successful rate event write (still inside the DB transaction), add:

```ts
// YUK-15 — flip referenced records to actioned. Pure side-effect; failure
// here MUST not roll back the accept (rate event is authoritative). Wrap
// in try/catch only if the surrounding code already does so; otherwise
// rely on the txn boundary.
const recordRefs = proposal.payload.evidence_refs.filter((ref) => ref.kind === 'record').map((ref) => ref.id);
if (recordRefs.length > 0) {
  await markRecordsActioned(tx, recordRefs);
}
```

Add `markRecordsActioned` to imports from `@/server/records/queries`.

- [ ] **Step 5: Run test, expect pass**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/proposals/actions.test.ts -t 'record evidence flip'
```

Expected: PASS (2 assertions).

- [ ] **Step 6: Commit**

```bash
git add src/server/proposals/actions.ts src/server/proposals/actions.test.ts
git commit -m "feat(proposals): flip record processing_status on accept (YUK-15)"
```

---

### Task 3: `GET /api/records/[id]/proposals` route

**Files:**
- Create: `app/api/records/[id]/proposals/route.ts`
- Create: `app/api/records/[id]/proposals/route.test.ts`

- [ ] **Step 1: Write failing route test**

Create `app/api/records/[id]/proposals/route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withDb } from '@/tests/helpers/db';
import { GET } from './route';
import { createLearningRecord } from '@/server/records/queries';
import { writeProposal } from '@/server/proposals/writer';

describe('GET /api/records/[id]/proposals', () => {
  it('returns proposals whose evidence_refs reference this record', async () => {
    await withDb(async (db) => {
      const rec = await createLearningRecord(db, {
        kind: 'mistake', content_md: 'demo', source: 'user',
        capture_mode: 'manual', activity_kind: 'study', knowledge_ids: [], payload: {},
      });
      const proposalId = await writeProposal(db, {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: 'root' },
        reason_md: 'r',
        evidence_refs: [{ kind: 'record', id: rec.record.id }],
        proposed_change: { mutation: 'propose_new', name: 'N', parent_id: 'root' },
      });

      const res = await GET(new Request(`http://test/api/records/${rec.record.id}/proposals`), { params: Promise.resolve({ id: rec.record.id }) });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].id).toBe(proposalId);
      expect(json.rows[0].kind).toBe('knowledge_node');
    });
  });

  it('returns empty array if no proposals reference the record', async () => {
    await withDb(async (db) => {
      const rec = await createLearningRecord(db, {
        kind: 'mistake', content_md: 'lonely', source: 'user',
        capture_mode: 'manual', activity_kind: 'study', knowledge_ids: [], payload: {},
      });
      const res = await GET(new Request(`http://test/api/records/${rec.record.id}/proposals`), { params: Promise.resolve({ id: rec.record.id }) });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.rows).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
pnpm vitest run --config vitest.db.config.ts app/api/records/\[id\]/proposals/route.test.ts
```

Expected: FAIL — file not found.

- [ ] **Step 3: Implement route**

Create `app/api/records/[id]/proposals/route.ts`:

```ts
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { listProposalsReferencingRecord } from '@/server/proposals/inbox';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const rows = await listProposalsReferencingRecord(db, id);
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 4: Add `listProposalsReferencingRecord` to inbox.ts**

Append to `src/server/proposals/inbox.ts`:

```ts
/**
 * Reverse lookup: find proposal-inbox rows whose payload.evidence_refs
 * contain { kind: 'record', id: recordId }. Used by the record detail
 * page (YUK-15) to surface "已产生 N 个 proposal".
 *
 * NOTE: scans propose events with jsonb containment — index on
 * (action='propose') is sufficient for current volume. If we ever
 * exceed ~100k propose events, add a GIN index on event.payload.
 */
export async function listProposalsReferencingRecord(
  db: DbLike,
  recordId: string,
): Promise<ProposalInboxRow[]> {
  const proposalIds = await db.execute(sql<{ id: string }>`
    select id from "event"
    where action = 'propose'
      and payload -> 'evidence_refs' @> ${JSON.stringify([{ kind: 'record', id: recordId }])}::jsonb
    order by created_at desc
    limit 50
  `);
  const ids = (proposalIds as unknown as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return [];
  const all = await loadProposalInboxRows(db);
  return all.filter((row) => ids.includes(row.id));
}
```

If `loadProposalInboxRows` does not exist, use the same loader path the GET `/api/proposals` route uses. Verify the exact helper name with:

```bash
grep -n "export async function\|export function" src/server/proposals/inbox.ts
```

- [ ] **Step 5: Run test, expect pass**

```bash
pnpm vitest run --config vitest.db.config.ts app/api/records/\[id\]/proposals/route.test.ts
```

Expected: PASS (2 assertions).

- [ ] **Step 6: Commit**

```bash
git add app/api/records/\[id\]/proposals/ src/server/proposals/inbox.ts
git commit -m "feat(records): GET /api/records/:id/proposals reverse lookup (YUK-15)"
```

---

### Task 4: UI design pre-flight (CLAUDE.md `feedback_ui_preflight`)

> 这一步必须在动 UI 代码前做完，不能跳。CLAUDE.md `feedback_ui_preflight` 写明：逐字引用 design doc 段落、声明组件类型、列出 touch 文件，等用户 approve 才动手。

- [ ] **Step 1: 引用 design 源**

YUK-15 没有专属 design doc。引用：
- [`docs/modules/records.md`](../../modules/records.md) §"详情 / 操作"（如存在；启动当天 grep `详情` 找）
- [`docs/superpowers/plans/2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) §M1.3 — backlink 形态描述
- [`app/(app)/inbox/page.tsx`](../../../app/\(app\)/inbox/page.tsx) `GenericProposalCard` 现有 `evidence_refs` chip 样式 —— 复用，不新建组件

- [ ] **Step 2: 声明组件类型**

- `app/(app)/records/[id]/page.tsx` —— **route page** (Next App Router segment)
- `GenericProposalCard` 内 record chip —— **inline 修改 existing component**，不抽组件
- record 详情页"已产生 proposal"区 —— **inline section** within page，不抽组件

- [ ] **Step 3: 列 touch 文件**

| 文件 | 类型 |
|---|---|
| `app/(app)/records/[id]/page.tsx` | 创建 |
| `app/(app)/inbox/page.tsx` | 修改 GenericProposalCard `evidence_refs` map |

- [ ] **Step 4: 等用户 approve**

Post 上面 3 步到 PR description / chat，等 "OK / approved / 继续" 类回复再进 Task 5。

---

### Task 5: Inbox card `record` evidence chip

**Files:**
- Modify: `app/(app)/inbox/page.tsx`

- [ ] **Step 1: Locate `GenericProposalCard` evidence_refs render**

```bash
grep -n "evidence_refs" app/\(app\)/inbox/page.tsx
```

Confirm current shape (already renders `event` kind as `<Link href={`/events/...`}>`).

- [ ] **Step 2: Extend chip mapper**

In `app/(app)/inbox/page.tsx`, replace the `evidence_refs.slice(0, 5).map((ref) => ...)` block with:

```tsx
{proposal.payload.evidence_refs.slice(0, 5).map((ref) => {
  if (ref.kind === 'event') {
    return (
      <Link href={`/events/${ref.id}`} key={`${ref.kind}:${ref.id}`}>
        {ref.kind}:{ref.id.slice(0, 8)}…
      </Link>
    );
  }
  if (ref.kind === 'record') {
    return (
      <Link href={`/records/${ref.id}`} key={`${ref.kind}:${ref.id}`}>
        {ref.kind}:{ref.id.slice(0, 8)}…
      </Link>
    );
  }
  return (
    <span key={`${ref.kind}:${ref.id}`}>
      {ref.kind}:{ref.id.slice(0, 8)}…
    </span>
  );
})}
```

- [ ] **Step 3: Manual smoke**

```bash
pnpm dev   # ensure port 3000 free first; otherwise it falls back to :3001
```

Open `http://localhost:3000/inbox` with a proposal that has a `record` evidence_ref (seed one if none). Verify the chip becomes a link.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/inbox/page.tsx
git commit -m "feat(inbox): render record evidence_refs as backlink chip (YUK-15)"
```

---

### Task 6: Record detail page

**Files:**
- Create: `app/(app)/records/[id]/page.tsx`

- [ ] **Step 1: Page shell**

Create `app/(app)/records/[id]/page.tsx`:

```tsx
'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { Shell } from '@/ui/components/Shell';

interface RecordRow {
  id: string;
  kind: string;
  title: string | null;
  content_md: string;
  processing_status: 'raw' | 'linked' | 'actioned' | 'archived';
  created_at: string;
  knowledge_ids: string[];
}

interface ProposalRow {
  id: string;
  kind: string;
  target: { subject_kind: string; subject_id: string | null };
  payload: { reason_md: string };
  created_at: string;
  status: 'pending' | 'accepted' | 'dismissed' | 'stale';
}

export default function RecordDetailPage() {
  const { id } = useParams<{ id: string }>();
  const recordQ = useQuery({
    queryKey: ['record', id],
    queryFn: () => apiJson<RecordRow>(`/api/records/${id}`),
    enabled: !!id,
  });
  const proposalsQ = useQuery({
    queryKey: ['record-proposals', id],
    queryFn: () => apiJson<{ rows: ProposalRow[] }>(`/api/records/${id}/proposals`),
    enabled: !!id,
  });

  return (
    <Shell>
      <PageHeader title="学习记录详情" eyebrow={`/records/${id}`} />
      <Link href="/record">← 返回记录列表</Link>

      {recordQ.isLoading && <p>加载中…</p>}
      {recordQ.isError && (
        <p style={{ color: 'var(--again-ink)' }}>
          {recordQ.error instanceof ApiAuthError
            ? `${recordQ.error.message} — 请重新进入页面输入 token`
            : `加载失败：${(recordQ.error as Error).message}`}
        </p>
      )}

      {recordQ.data && (
        <Card elevated>
          <div>
            <Badge>{recordQ.data.kind}</Badge>
            <Badge>{recordQ.data.processing_status}</Badge>
          </div>
          <h2>{recordQ.data.title ?? recordQ.data.content_md.slice(0, 60)}</h2>
          <p>{recordQ.data.content_md}</p>
        </Card>
      )}

      <section style={{ marginTop: 'var(--s-3)' }}>
        <h3>已产生的 proposal（{proposalsQ.data?.rows.length ?? 0}）</h3>
        {proposalsQ.data?.rows.length === 0 && <p>暂无关联 proposal。</p>}
        {proposalsQ.data?.rows.map((row) => (
          <Card key={row.id}>
            <Badge>{row.kind}</Badge>
            <Badge>{row.status}</Badge>
            <p>{row.payload.reason_md}</p>
            <Link href={`/inbox?focus=${row.id}`}>→ 在 inbox 查看</Link>
          </Card>
        ))}
      </section>
    </Shell>
  );
}
```

- [ ] **Step 2: Manual smoke**

```bash
pnpm dev
```

Open `http://localhost:3000/records/<a-real-record-id>` — should show:
1. record content + status badges
2. "已产生的 proposal" section（0 or N rows）

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/records/\[id\]/page.tsx
git commit -m "feat(records): add /records/[id] detail page with proposal backlinks (YUK-15)"
```

---

### Task 7: Round-trip E2E test

**Files:**
- Test: `app/api/records/\[id\]/proposals/route.test.ts` (extend)

- [ ] **Step 1: Write round-trip test**

Append to `app/api/records/[id]/proposals/route.test.ts`:

```ts
describe('record → proposal → accept → flip round trip', () => {
  it('record stays raw while proposal pending; flips to actioned on accept', async () => {
    await withDb(async (db) => {
      const rec = await createLearningRecord(db, {
        kind: 'mistake', content_md: 'rt', source: 'user',
        capture_mode: 'manual', activity_kind: 'study', knowledge_ids: [], payload: {},
      });
      const proposalId = await writeProposal(db, {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: 'root' },
        reason_md: 'r',
        evidence_refs: [{ kind: 'record', id: rec.record.id }],
        proposed_change: { mutation: 'propose_new', name: 'N', parent_id: 'root' },
      });

      // Pending state — record still raw
      let rows = await listLearningRecords(db, { limit: 10 });
      expect(rows.find((r) => r.id === rec.record.id)?.processing_status).toBe('raw');

      // Accept
      await acceptProposal(db, { proposalId, actor: 'self' });

      // Actioned
      rows = await listLearningRecords(db, { limit: 10 });
      expect(rows.find((r) => r.id === rec.record.id)?.processing_status).toBe('actioned');

      // Backlink survives accept
      const res = await GET(new Request(`http://test/api/records/${rec.record.id}/proposals`), { params: Promise.resolve({ id: rec.record.id }) });
      const json = await res.json();
      expect(json.rows.find((r: ProposalRow) => r.id === proposalId)).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run test, expect pass**

```bash
pnpm vitest run --config vitest.db.config.ts app/api/records/\[id\]/proposals/route.test.ts -t 'round trip'
```

Expected: PASS.

- [ ] **Step 3: Run full lane test gate**

```bash
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test
```

All green → ready for PR.

- [ ] **Step 4: Commit**

```bash
git add app/api/records/\[id\]/proposals/route.test.ts
git commit -m "test(records): round-trip record → proposal → accept (YUK-15)"
```

---

## Exit criteria recap (mirror Linear acceptance)

- [ ] `learning_record.processing_status` 从 `raw` 流到 `actioned`（不新加字段）
- [ ] producer accept proposal 时正确标 record processed（Task 2 + Task 7）
- [ ] inbox UI 渲染 `evidence_refs.record` 为可点击 backlink（Task 5）
- [ ] record 详情页显示「已产生 N 个 proposal」 + 各自链接（Task 6）
- [ ] `pnpm test:db` 覆盖双向跳转（Task 7）
- [ ] `pnpm audit:schema` PASS（不动 schema，自然通过）

## Linear capture gate（PR 前）

- 把发现的所有 follow-up（如：`listProposalsReferencingRecord` 性能 ≥100k 时需 GIN 索引、record 详情页加 mark-as-archived 入口等）开成 Linear issue 或显式说明不需要
- PR title 用 Linear branch 名（`YUK-15 record → proposal evidence loop 接通`）；commit message 含 `Closes YUK-15` 触发 Linear integration auto-attach

## ADR 触发判断

本 lane 不触发新 ADR：
- 没新加 KnownEvent action（accept 路径已有 rate event）
- 没破坏 schema 形态（仅复用 `processing_status` 枚举的 `'actioned'`）
- 没改变 `AiProposalPayload` union（`record` evidence kind 早已支持）

如果实施过程中决定加 `linked` 中间态语义（producer **propose**（不 accept）时也 flip），需新 ADR 记录 record lifecycle 语义并扩展枚举使用。
