# YUK-57 — Review UX P2.2: skip question + pause/resume session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** review session 加 skip / pause / resume 三个动作；pause 写 `paused` 状态（ADR-0013 状态机扩展，需 ADR amendment）；resume 回到 `started`；skip 不算 attempt 不动 FSRS，但写一条 `experimental:question_skip` event 留痕。

**Architecture:** session lifecycle 扩展 `started ↔ paused → completed | abandoned`，新 transition 走 `src/server/session/review.ts`（沿用现有 `assertFromState` 模式）。skip 是 per-question level，不动 session status，只写 `event(action='experimental:question_skip', subject_kind='question')` for observability + UX 推到下一题。三个新 route 平行：`POST /api/review/sessions/[id]/{pause,resume,skip}`。前端在 `app/(app)/review/page.tsx` review-stage 上方加三个按钮 + done 状态加 resume 入口；`/learning-sessions` 列表显示 paused 标记。

**Tech Stack:** Drizzle (`learning_session`) / Next App Router / Zod / `src/server/session/review.ts` 状态机 / pg-boss 现有 `prune_orphan_review_sessions` cron（评估是否扩到 paused）

**Lane meta:**
- Linear: [YUK-57](https://linear.app/yukoval-studios/issue/YUK-57) (5pts, M2, High)，sub-issue of [YUK-18](https://linear.app/yukoval-studios/issue/YUK-18)
- Wave: W2，chain-merge 位置 #4（YUK-52 之后；review 区第 2 个，前置 YUK-56 已在 W1）
- Git branch: `yukovaldakia09/yuk-57-review-ux-p22-skip-question-pauseresume-session`
- Parent outline: [`2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) §M2.3 Sub P2.2
- Cross-cutting helpers：**CC-2 correction renderer** —— pause/resume 是 lifecycle 事件，**不要**借用 correction event channel。再确认一遍：correction event 是给 retract/mark_wrong/supersede 用的，session pause 不在其语义范围。

**Pre-flight：**
1. `git fetch origin main && git rebase origin/main` —— 必须 rebase 上 W1（特别是 YUK-56 改了 review/page.tsx 的 submit 流程；本 lane 共享同一文件）
2. 重读 [ADR-0013](../../adr/0013-review-session-lifecycle.md) 全文，理解 lifecycle 决议；本 lane 写 ADR amendment（不重写 ADR）
3. `lsof -nP -iTCP:3000`
4. `pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile`
5. **冲突检查**：`git diff origin/main -- app/\(app\)/review/page.tsx`（看 YUK-56 改了哪些；确认本 lane 改动区是新增按钮区，不冲突）

---

## File Structure

**Create:**
- `docs/adr/0013-amendment-1-pause-resume.md` —— ADR-0013 amendment，新增 `paused` 状态决议（约 80-120 行）
- `app/api/review/sessions/[id]/pause/route.ts`
- `app/api/review/sessions/[id]/pause/route.test.ts`
- `app/api/review/sessions/[id]/resume/route.ts`
- `app/api/review/sessions/[id]/resume/route.test.ts`
- `app/api/review/sessions/[id]/skip/route.ts`
- `app/api/review/sessions/[id]/skip/route.test.ts`

**Modify:**
- `src/server/session/review.ts` —— 加 `pauseReviewSession()` / `resumeReviewSession()`；放宽 `completeReviewSession` / `abandonReviewSession` 接受 `paused`
- `src/server/session/review.test.ts` —— 覆盖新 transition + 边界（pause from completed → throw, etc.）
- `src/core/schema/event/known.ts` 或 `experimental.ts` —— 加 `experimental:question_skip` 注释（按现有 experimental action 模式；不强制 union 严守）
- `src/server/orchestrator/review.ts` —— `getReviewPlan` 跳过被 `experimental:question_skip` 最近 N 分钟内标过的题（避免 skip 后立刻又出现）
- `app/(app)/review/page.tsx` —— skip / pause 按钮区 + paused state UI；done 状态不变
- `app/(app)/learning-sessions/[id]/page.tsx` —— paused 标识 + resume 按钮（同时为后续 YUK-63 abandoned resume 共享入口）

**No changes:**
- `learning_session` schema —— `status` 是 text 列已支持任意值；只需在 Zod schema 文件加 `'paused'`
- `pg-boss prune_orphan_review_sessions` cron —— **保留当前 6h started cutoff**；paused 不进 abandoned（pause 是用户显式动作）。本 lane 标 follow-up issue if needed
- ADR-0013 原文 —— 不改，只 amendment

---

## Tasks

### Task 1: UI design pre-flight (CLAUDE.md `feedback_ui_preflight`)

> 强约束。不跳。

- [ ] **Step 1: 引用 design 源**

- [ADR-0013](../../adr/0013-review-session-lifecycle.md) §"决策" + §"实施步骤" —— 现状 lifecycle + 6h orphan cron
- [`docs/superpowers/plans/2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) §M2.3 Sub P2.2 + Cross-cutting CC-2 —— pause/resume 不借 correction channel
- [`app/(app)/review/page.tsx`](../../../app/\(app\)/review/page.tsx) `review-stage` section + `SessionEndSummary` 现有按钮区
- 没有专属 design doc。本 lane 的 UI 决策点：
  - skip 按钮位置：`review-stage` `.progress` 行的右侧 → 与 `?` reveal 按钮（如存在）并列
  - pause 按钮位置：页面右上 header 区 / `eyebrow` 行下
  - paused state 显示：覆盖整个 `review-stage` 区域，显示 "Session paused · click resume to continue" + Resume 按钮
  - **不复用** `CorrectionStateRenderer`（CC-2 明确禁止）

- [ ] **Step 2: 声明组件类型**

- skip / pause / resume 按钮 —— **inline UI elements**（直接在 page.tsx 写，不抽组件）
- paused state overlay —— **inline section** within page，不抽
- `app/(app)/learning-sessions/[id]/page.tsx` 的 paused 标记 —— **inline UI**
- Resume 入口 —— 复用现有 Link 组件 / Button primitive

- [ ] **Step 3: 列 touch 文件**

| 文件 | 类型 |
|---|---|
| `app/(app)/review/page.tsx` | 修改（加 buttons + paused overlay） |
| `app/(app)/learning-sessions/[id]/page.tsx` | 修改（paused badge + resume link） |

- [ ] **Step 4: 等用户 approve**

Post 给用户：上面 3 步 + ADR amendment 计划（task 2 会先写）。等 OK。

---

### Task 2: ADR-0013 amendment

**Files:**
- Create: `docs/adr/0013-amendment-1-pause-resume.md`

- [ ] **Step 1: 写 amendment**

Create `docs/adr/0013-amendment-1-pause-resume.md`:

```markdown
# ADR-0013 Amendment 1 — Review session 增加 `paused` 状态

**状态**：accepted
**日期**：2026-05-2X (lane 启动日期填入)
**前置**：ADR-0013（accepted, 2026-05-17）
**链接 issue**：[YUK-57](https://linear.app/yukoval-studios/issue/YUK-57)

## 决策

ADR-0013 原状态机 `started → completed | abandoned` 扩展为：

```
started ↔ paused → completed | abandoned
                    ↑
                    └── started
```

新增 transition：
- `pauseReviewSession(sessionId)` —— `started → paused`，写 `paused_at`、`updated_at`
- `resumeReviewSession(sessionId)` —— `paused → started`，写 `updated_at`（不清 `paused_at`，保留 audit）
- `completeReviewSession` —— 接受 `['started', 'paused']`（pause 后直接 complete 视为完成）
- `abandonReviewSession` —— 接受 `['started', 'paused']`
- `prune_orphan_review_sessions` cron **保留**只扫 `started > 6h`，**不**扫 paused（pause 是用户显式动作，没有"忘记"语义）

## 背景

YUK-57 (Review session UX P2.2) 要让用户主动 pause 一次 session，稍后从 `/learning-sessions` 列表 resume，不必依赖 6h orphan cron 兜底（已被 abandoned，无 resume 路径）。

## 选项

### A. 加 `paused` 状态 （**accepted**）

显式语义、可恢复、cron 不影响。

### B. 不加状态，pause 等同 abandoned，resume = new session

简单但丢 session 边界，事件链断裂；session_summary 提前触发；周报数据偏。

### C. URL-only pause（前端 state，不入 DB）

无 cross-device pause；用户刷新就丢；不符合 ADR-0006 v2 "event-driven core" 精神。

## 不影响 ADR-0013 决议

- eager session 创建机制不变
- sendBeacon on pagehide 仍写 `complete`（如果 session 在 `paused` 而页面关闭，**保持 paused** 不自动 complete —— 由 cron 或下次访问决定）
- 6h orphan cron 仍只针对 `started`

## 触发重新评估

如果 paused session 长期堆积（cron 不处理），考虑加 paused expiry（如 30 天自动 abandoned）。本 amendment 不实现，留 follow-up。
```

- [ ] **Step 2: Commit amendment first**

```bash
git add docs/adr/0013-amendment-1-pause-resume.md
git commit -m "docs(adr): 0013 amendment 1 — add paused state for YUK-57"
```

---

### Task 3: 扩展 review session 状态机

**Files:**
- Modify: `src/server/session/review.ts`
- Modify: `src/server/session/review.test.ts`

- [ ] **Step 1: 写 failing tests**

Append to `src/server/session/review.test.ts`:

```ts
describe('pauseReviewSession', () => {
  it('started → paused', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await pauseReviewSession(db, sessionId);
      const row = await loadReviewSession(db, sessionId);
      expect(row.status).toBe('paused');
      expect(row.paused_at).not.toBeNull();
    });
  });

  it('throws if session not started', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await completeReviewSession(db, sessionId);
      await expect(pauseReviewSession(db, sessionId)).rejects.toThrow();
    });
  });
});

describe('resumeReviewSession', () => {
  it('paused → started', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await pauseReviewSession(db, sessionId);
      await resumeReviewSession(db, sessionId);
      const row = await loadReviewSession(db, sessionId);
      expect(row.status).toBe('started');
    });
  });

  it('throws if not paused', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await expect(resumeReviewSession(db, sessionId)).rejects.toThrow();
    });
  });
});

describe('complete / abandon accept paused', () => {
  it('paused → completed', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await pauseReviewSession(db, sessionId);
      await completeReviewSession(db, sessionId);
      const row = await loadReviewSession(db, sessionId);
      expect(row.status).toBe('completed');
    });
  });

  it('paused → abandoned', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await pauseReviewSession(db, sessionId);
      await abandonReviewSession(db, sessionId);
      const row = await loadReviewSession(db, sessionId);
      expect(row.status).toBe('abandoned');
    });
  });
});
```

`loadReviewSession` helper: if not present, write a tiny one in test scope that selects from `learning_session` by id.

- [ ] **Step 2: Run, expect fail**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/session/review.test.ts -t 'pauseReviewSession\|resumeReviewSession\|complete / abandon accept paused'
```

Expected: FAIL — functions don't exist; complete/abandon reject `paused`.

- [ ] **Step 3: Implement `pauseReviewSession`**

Append to `src/server/session/review.ts` (after `abandonReviewSession`):

```ts
/**
 * started → paused. Sets paused_at = now, updates updated_at, bumps version.
 * Per ADR-0013 amendment 1.
 */
export async function pauseReviewSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadReviewSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} (type=review) not found`, 404);
    }
    assertFromState(current.status, ['started'] as const, sessionId, 'Review.pauseReviewSession');

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'paused',
        paused_at: now,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'review.paused',
      payload: {},
    });
  });
}

/**
 * paused → started. Updates updated_at, bumps version. Does NOT clear
 * paused_at (audit trail).
 */
export async function resumeReviewSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadReviewSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} (type=review) not found`, 404);
    }
    assertFromState(current.status, ['paused'] as const, sessionId, 'Review.resumeReviewSession');

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'started',
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'review.resumed',
      payload: {},
    });
  });
}
```

- [ ] **Step 4: 放宽 complete/abandon assert**

In `src/server/session/review.ts`, change the `assertFromState` calls in `completeReviewSession` and `abandonReviewSession` from `['started']` to `['started', 'paused']`.

- [ ] **Step 5: Add `paused_at` column**

Check `src/db/schema.ts` `learning_session` table. If `paused_at` doesn't exist, add column:

```ts
paused_at: timestamp('paused_at', { withTimezone: true }),
```

Generate migration:

```bash
pnpm db:generate
```

Inspect the new `src/db/migrations/*` file; ensure it's `ADD COLUMN paused_at` only.

- [ ] **Step 6: Update Zod / business schema for status**

In whichever file defines the `learning_session.status` enum for review type (search: `grep -n "type='review'\|review.*status" src/core/schema/`), add `'paused'`:

```ts
ReviewSessionStatus = z.enum(['started', 'paused', 'completed', 'abandoned']);
```

- [ ] **Step 7: Run tests, expect pass**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/session/review.test.ts
```

Expected: all PASS (incl. new + existing transitions).

- [ ] **Step 8: Commit**

```bash
git add src/server/session/review.ts src/server/session/review.test.ts src/db/schema.ts src/db/migrations src/core/schema/
git commit -m "feat(session): pause/resume review session per ADR-0013 amend 1 (YUK-57)"
```

---

### Task 4: `POST /api/review/sessions/[id]/pause` route

**Files:**
- Create: `app/api/review/sessions/[id]/pause/route.ts`
- Create: `app/api/review/sessions/[id]/pause/route.test.ts`

- [ ] **Step 1: Write failing test**

Create `app/api/review/sessions/[id]/pause/route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withDb } from '@/tests/helpers/db';
import { POST } from './route';
import { startReviewSession } from '@/server/session/review';

describe('POST /api/review/sessions/[id]/pause', () => {
  it('200 — pauses started session', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      const res = await POST(new Request(`http://test/api/review/sessions/${sessionId}/pause`, { method: 'POST' }), { params: Promise.resolve({ id: sessionId }) });
      expect(res.status).toBe(200);
    });
  });

  it('404 — session not found', async () => {
    const res = await POST(new Request('http://test/api/review/sessions/missing/pause', { method: 'POST' }), { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('400 — session not started', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await POST(new Request(`http://test/api/review/sessions/${sessionId}/pause`, { method: 'POST' }), { params: Promise.resolve({ id: sessionId }) });
      // second pause attempt
      const res = await POST(new Request(`http://test/api/review/sessions/${sessionId}/pause`, { method: 'POST' }), { params: Promise.resolve({ id: sessionId }) });
      expect([400, 409]).toContain(res.status);
    });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm vitest run --config vitest.db.config.ts app/api/review/sessions/\[id\]/pause/route.test.ts
```

Expected: FAIL — route not found.

- [ ] **Step 3: Implement route**

Create `app/api/review/sessions/[id]/pause/route.ts`:

```ts
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { Review } from '@/server/session';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    await Review.pauseReviewSession(db, id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
```

Add `pauseReviewSession` to `src/server/session/index.ts` Review namespace re-export.

- [ ] **Step 4: Run, expect pass**

```bash
pnpm vitest run --config vitest.db.config.ts app/api/review/sessions/\[id\]/pause/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/review/sessions/\[id\]/pause/ src/server/session/index.ts
git commit -m "feat(api): POST /api/review/sessions/:id/pause (YUK-57)"
```

---

### Task 5: `POST /api/review/sessions/[id]/resume` route

**Files:**
- Create: `app/api/review/sessions/[id]/resume/route.ts`
- Create: `app/api/review/sessions/[id]/resume/route.test.ts`

Mirror Task 4 structure exactly. Test cases:
- 200 — paused → started
- 404 — not found
- 400 — session not paused (still started, or completed)

- [ ] **Step 1: Write failing test (mirror Task 4 structure)**

```ts
import { describe, expect, it } from 'vitest';
import { withDb } from '@/tests/helpers/db';
import { POST } from './route';
import { startReviewSession, pauseReviewSession } from '@/server/session/review';

describe('POST /api/review/sessions/[id]/resume', () => {
  it('200 — resumes paused session', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await pauseReviewSession(db, sessionId);
      const res = await POST(new Request(`http://test/api/review/sessions/${sessionId}/resume`, { method: 'POST' }), { params: Promise.resolve({ id: sessionId }) });
      expect(res.status).toBe(200);
    });
  });

  it('400 — not paused', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      const res = await POST(new Request(`http://test/api/review/sessions/${sessionId}/resume`, { method: 'POST' }), { params: Promise.resolve({ id: sessionId }) });
      expect([400, 409]).toContain(res.status);
    });
  });
});
```

- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement route** — same shape as pause/route.ts, calling `Review.resumeReviewSession(db, id)`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit**

```bash
git add app/api/review/sessions/\[id\]/resume/
git commit -m "feat(api): POST /api/review/sessions/:id/resume (YUK-57)"
```

---

### Task 6: `POST /api/review/sessions/[id]/skip` route

**Files:**
- Create: `app/api/review/sessions/[id]/skip/route.ts`
- Create: `app/api/review/sessions/[id]/skip/route.test.ts`

> Skip is per-question, not session lifecycle. It writes one `event(action='experimental:question_skip', subject_kind='question', subject_id=<qid>)` with `session_id=<this session>`, no FSRS state change. Body: `{ question_id, activity_ref? }`.

- [ ] **Step 1: Write failing test**

Create `app/api/review/sessions/[id]/skip/route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withDb } from '@/tests/helpers/db';
import { POST } from './route';
import { startReviewSession } from '@/server/session/review';
import { db as realDb } from '@/db/client';
import { event } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

describe('POST /api/review/sessions/[id]/skip', () => {
  it('200 — writes experimental:question_skip event with session linkage', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      const res = await POST(
        new Request(`http://test/api/review/sessions/${sessionId}/skip`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question_id: 'q_test' }),
        }),
        { params: Promise.resolve({ id: sessionId }) },
      );
      expect(res.status).toBe(200);

      const rows = await db.select().from(event).where(and(eq(event.action, 'experimental:question_skip'), eq(event.session_id, sessionId)));
      expect(rows).toHaveLength(1);
      expect(rows[0].subject_id).toBe('q_test');
    });
  });

  it('400 — missing question_id', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      const res = await POST(
        new Request(`http://test/api/review/sessions/${sessionId}/skip`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        { params: Promise.resolve({ id: sessionId }) },
      );
      expect(res.status).toBe(400);
    });
  });

  it('does not write attempt event or update FSRS state', async () => {
    await withDb(async (db) => {
      const { sessionId } = await startReviewSession(db);
      await POST(
        new Request(`http://test/api/review/sessions/${sessionId}/skip`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question_id: 'q2' }),
        }),
        { params: Promise.resolve({ id: sessionId }) },
      );
      const attempts = await db.select().from(event).where(and(eq(event.action, 'attempt'), eq(event.subject_id, 'q2')));
      expect(attempts).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement route**

Create `app/api/review/sessions/[id]/skip/route.ts`:

```ts
import { z } from 'zod';
import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const SkipBody = z.object({
  question_id: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await params;
    const raw = await req.json().catch(() => null);
    const parsed = SkipBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }

    await writeEvent(db, {
      id: newId(),
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:question_skip',
      subject_kind: 'question',
      subject_id: parsed.data.question_id,
      outcome: 'success',
      payload: {},
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit**

```bash
git add app/api/review/sessions/\[id\]/skip/
git commit -m "feat(api): POST /api/review/sessions/:id/skip (YUK-57)"
```

---

### Task 7: `getReviewPlan` 跳过最近 skip 过的题（防 immediate re-show）

**Files:**
- Modify: `src/server/orchestrator/review.ts`
- Modify: `src/server/orchestrator/review.test.ts`

> Why: 没这个 guard，skip → next question → 队列推满后又轮回到刚 skip 的题，体验不对。窗口 30 分钟够。

- [ ] **Step 1: Write failing test**

Append to `src/server/orchestrator/review.test.ts`:

```ts
describe('getReviewPlan — skip cooldown', () => {
  it('excludes question_ids skipped within last 30 minutes in the current session', async () => {
    await withDb(async (db) => {
      // Setup: question q_skip in queue, write skip event 5 min ago
      // ... (use existing fixture helpers)
      const { sessionId } = await startReviewSession(db);
      await writeEvent(db, { /* skip event q_skip 5min ago, session_id=sessionId */ } as never);
      const plan = await getReviewPlan(db, { limit: 50, sessionId });
      expect(plan.queue.find((r) => r.question_id === 'q_skip')).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement filter**

In `src/server/orchestrator/review.ts`, in the queue builder, add a step that subtracts skipped question_ids:

```ts
// YUK-57 — skip cooldown: exclude question_ids that user skipped in the
// last 30 minutes within the current session. Without this, skip → next →
// queue wrap-around → same question reappears.
if (sessionId) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const skipped = await db
    .select({ qid: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:question_skip'),
        eq(event.session_id, sessionId),
        gte(event.created_at, cutoff),
      ),
    );
  const skipSet = new Set(skipped.map((s) => s.qid));
  // Filter both `due` and `never-reviewed` paths.
  items = items.filter((it) => !skipSet.has(it.question_id));
}
```

If `getReviewPlan` doesn't currently accept `sessionId`, add it as optional param + thread through `getReviewPlan({ sessionId })` callers. **Confirm propagation** with:

```bash
grep -rn "getReviewPlan" src/ app/
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/review.ts src/server/orchestrator/review.test.ts
git commit -m "feat(orchestrator): skip-cooldown filter for review queue (YUK-57)"
```

---

### Task 8: Frontend skip / pause / resume buttons

**Files:**
- Modify: `app/(app)/review/page.tsx`

- [ ] **Step 1: Add mutation hooks**

In `app/(app)/review/page.tsx`, near the existing `submitM` mutation, add:

```tsx
const skipM = useMutation({
  mutationFn: () => {
    if (!current || !sessionId) throw new Error('no current question / session');
    return apiJson(`/api/review/sessions/${sessionId}/skip`, {
      method: 'POST',
      body: JSON.stringify({ question_id: current.question_id }),
    });
  },
  onSuccess: () => {
    setIndex((i) => i + 1);
    setPhase('answering');
    setAnswer('');
    setShowRef(false);
    qc.invalidateQueries({ queryKey: ['review-plan'] });
  },
});

const pauseM = useMutation({
  mutationFn: () => {
    if (!sessionId) throw new Error('no session');
    return apiJson(`/api/review/sessions/${sessionId}/pause`, { method: 'POST' });
  },
  onSuccess: () => setSessionPaused(true),
});

const resumeM = useMutation({
  mutationFn: () => {
    if (!sessionId) throw new Error('no session');
    return apiJson(`/api/review/sessions/${sessionId}/resume`, { method: 'POST' });
  },
  onSuccess: () => setSessionPaused(false),
});

const [sessionPaused, setSessionPaused] = useState(false);
```

- [ ] **Step 2: Add buttons in review-stage**

Within the `<section className="review-stage">` block, above the question prompt, add:

```tsx
<div className="review-actions">
  <Button variant="ghost" disabled={skipM.isPending || sessionPaused} onClick={() => skipM.mutate()}>跳过</Button>
  <Button variant="ghost" disabled={pauseM.isPending || sessionPaused} onClick={() => pauseM.mutate()}>暂停</Button>
</div>
```

- [ ] **Step 3: Paused state overlay**

Just before the `current && !isDone && (...)` block, add:

```tsx
{sessionPaused && (
  <section className="review-stage review-paused">
    <p>Session 已暂停。下次访问可从此处继续。</p>
    <Button onClick={() => resumeM.mutate()} disabled={resumeM.isPending}>继续</Button>
  </section>
)}
```

And gate the existing stage block: `{!sessionPaused && current && !isDone && (...)}`.

- [ ] **Step 4: Manual smoke**

```bash
lsof -nP -iTCP:3000
pnpm dev
```

Open `/review`, click 跳过 → next question, no FSRS write. Click 暂停 → overlay shows. Click 继续 → stage back.

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/review/page.tsx
git commit -m "feat(review): skip + pause/resume UI buttons (YUK-57)"
```

---

### Task 9: `/learning-sessions/[id]` paused 标识 + resume 入口

**Files:**
- Modify: `app/(app)/learning-sessions/[id]/page.tsx`

- [ ] **Step 1: Add paused badge**

Locate the session metadata render block. Add:

```tsx
{session.status === 'paused' && (
  <div className="session-paused-banner">
    <Badge tone="warning">已暂停</Badge>
    <Link href={`/review?session=${session.id}&resume=1`}>→ 继续</Link>
  </div>
)}
```

- [ ] **Step 2: In `/review` page, handle `?resume=1`**

In `app/(app)/review/page.tsx`, at session init `useEffect`:

```tsx
const sp = useSearchParams();
const resumeFromSession = sp?.get('session') && sp?.get('resume') === '1';
// If resumeFromSession, attempt POST /resume and set sessionId from query
```

- [ ] **Step 3: Manual smoke**

Pause a session → open `/learning-sessions/<id>` → see badge + 继续 link → click → returns to `/review` and resumes.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/learning-sessions/\[id\]/page.tsx app/\(app\)/review/page.tsx
git commit -m "feat(sessions): paused badge + resume entry on session detail (YUK-57)"
```

---

### Task 10: Full lane test gate

- [ ] **Step 1: Run all tests**

```bash
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test
```

Expected: all green.

- [ ] **Step 2: Manual E2E recap**

1. Start review → click 跳过 → confirm next question, no attempt event in DB for that question
2. Click 暂停 → DB shows `status='paused'`, `paused_at` set
3. Open `/learning-sessions/<id>` → see paused badge
4. Click 继续 → back to `/review`, status `'started'`, queue resumes
5. End normally → `status='completed'`, `paused_at` preserved
6. Pause then close tab → no abandon (cron still only scans `started > 6h`)

- [ ] **Step 3: PR description**

Include:
- ADR-0013 amendment 1 link
- Skip cooldown 30min rationale
- 6h orphan cron behavior unchanged (paused sessions NOT auto-abandoned — follow-up issue noted)
- Coordination with YUK-63 (P3.4 abandoned session resume) —— resume 入口已统一在 `/learning-sessions` 详情页

---

## Exit criteria recap (mirror Linear acceptance)

- [ ] review 当前题有「跳过」按钮 —— Task 8
- [ ] session 有「暂停」按钮 → 写 paused event —— Task 8 + Task 3 (writeJobEvent)
- [ ] paused session 能从 `/learning-sessions` resume —— Task 9
- [ ] skip 的题 FSRS 影响明确（不算 attempt，只 observability event）—— Task 6 test 3
- [ ] 与 P3.4 (abandoned session resume entry) 协调（resume 入口统一）—— Task 9 用 `/learning-sessions` 作 SoT

## Linear capture gate（PR 前）

必开 follow-up Linear issues：
1. **paused session expiry policy** —— 当前 cron 不动 paused，长期 paused 堆积无 cleanup。建议 30 天 cutoff。
2. **`experimental:question_skip` → known event 升级** —— 当前用 experimental action，等用了 1-2 周 stable 后可升 known union
3. **`/learning-sessions` 列表 paused 筛选** —— Task 9 改了详情页但列表没筛 paused，YUK-63 一起处理

PR title 用 Linear branch；commit message 含 `Closes YUK-57`。

## ADR 触发

**已触发**：ADR-0013 amendment 1（Task 2）。修订决议而非新 ADR，因为 lifecycle 是同一 SoT 的延伸。
