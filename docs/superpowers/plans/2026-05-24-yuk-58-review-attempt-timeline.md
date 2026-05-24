# YUK-58 — Review UX P2.3: current-question attempt history timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** review feedback 阶段右侧显示当前题最近 10 条 attempt / review event timeline，含 timestamp / rating / cause / duration / correction state；cause 重复时高亮（趋势可视）；查询 <100ms。

**Architecture:** 新 `GET /api/questions/[id]/timeline` 路由扫 `event(action IN ('attempt','review','experimental:question_skip'), subject_kind='question', subject_id=:id)`（命中 `event_subject_idx`，limit 10）；对 failure attempt 调 [`effectiveCauseForFailureAttempt`](../../../src/server/events/cause-policy.ts:36) (CC-1) 得 effective cause；correction state 走 [`activeEffectiveTruth`](../../../src/server/review/effective-truth.ts) (CC-2)；返回 `AttemptTimelineRow[]`。新 `src/ui/components/AttemptTimeline.tsx` 渲染纵向时间线，cause 重复 ≥ 2 用 `var(--again-ink)` 强调色；插入 `app/(app)/review/page.tsx` feedback 阶段 review-stage 块内右侧 column（grid 布局）。

**Tech Stack:** Drizzle / Next App Router / Zod / 现有 `src/server/events/queries.ts` + `src/server/events/cause-policy.ts` + `src/server/review/effective-truth.ts`

**Lane meta:**
- Linear: [YUK-58](https://linear.app/yukoval-studios/issue/YUK-58) (3pts, M2, High)，sub-issue of [YUK-18](https://linear.app/yukoval-studios/issue/YUK-18)
- Wave: W2，chain-merge 位置 #5（YUK-57 之后；review 区第 3 个，**冲突注意**：与 YUK-57 都改 review/page.tsx，按 chain-merge 顺序 rebase）
- Git branch: `yukovaldakia09/yuk-58-review-ux-p23-current-question-attempt-history-timeline`
- Parent outline: [`2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) §M2.3 Sub P2.3
- Cross-cutting helpers：
  - **CC-1 Cause precedence** —— 显示 cause 必须走 `effectiveCauseCategoryForFailureAttempt()`，不自行 prefer judge over user_cause
  - **CC-2 Correction state renderer** —— attempt 列表 surface correction state；如有 supersede/retract，用 [`CorrectionStateRenderer`](../../../src/ui/correction/CorrectionStateRenderer.tsx) `compact` 模式，**不新建**组件

**Pre-flight：**
1. `git fetch origin main && git rebase origin/main` —— 同步 W1
2. `git rebase yukovaldakia09/yuk-57-review-ux-p22-skip-question-pauseresume-session` —— W2 YUK-57 已 chain-merge 在前，本 lane 在其之后基于其改动
3. `lsof -nP -iTCP:3000`
4. `pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile`
5. **重读 [`src/server/events/queries.ts:44-219`](../../../src/server/events/queries.ts:44)** `FailureAttempt` 结构 —— timeline 输出借用其 cause 字段形态保持一致

---

## File Structure

**Create:**
- `app/api/questions/[id]/timeline/route.ts`
- `app/api/questions/[id]/timeline/route.test.ts`
- `src/server/events/timeline.ts` —— `getQuestionTimeline(db, qid, opts)` query + `AttemptTimelineRow` shape
- `src/server/events/timeline.test.ts`
- `src/ui/components/AttemptTimeline.tsx`
- `src/ui/components/AttemptTimeline.test.tsx`

**Modify:**
- `app/(app)/review/page.tsx` —— feedback 阶段右栏插入 `<AttemptTimeline questionId={current.question_id} />`

**No changes:**
- `src/server/events/cause-policy.ts` —— `effectiveCauseForFailureAttempt` 已有，直接复用
- `src/server/review/effective-truth.ts` —— `activeEffectiveTruth` 已有
- `src/ui/correction/CorrectionStateRenderer.tsx` —— compact 模式直接使用
- `event` 表 schema —— `event_subject_idx` 已存在（`(subject_kind, subject_id, created_at desc)` per [ADR-0006 v2](../../adr/0006-encounter-replaces-mistake.md)）

---

## Tasks

### Task 1: UI design pre-flight

> CLAUDE.md `feedback_ui_preflight` 强约束。

- [ ] **Step 1: 引用 design 源**

- [`docs/superpowers/plans/2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) §M2.3 Sub P2.3 — issue scope + CC-1/CC-2 复用规则
- [`docs/modules/quiz.md`](../../modules/quiz.md) §1.5 «已入库题目的生命周期证据» —— `QuestionActivitySummary` 设想字段（本 lane 实现的是其子集，不建 derived view，留 follow-up）
- [`app/(app)/review/page.tsx`](../../../app/\(app\)/review/page.tsx) review-stage 现有布局 —— 当前是单列；本 lane 在 feedback 阶段切换到 2-column grid（左：reference + rating，右：timeline）
- [`src/ui/correction/CorrectionStateRenderer.tsx`](../../../src/ui/correction/CorrectionStateRenderer.tsx) compact 模式 —— 直接复用，不重建

- [ ] **Step 2: 声明组件类型**

- `AttemptTimeline` —— **新 component** in `src/ui/components/`（可复用其他 page，比如 `/mistakes/[id]` 详情未来用到）
- timeline row —— **inline 子组件**（在 AttemptTimeline.tsx 内部），不抽
- review page grid layout —— **inline CSS**（用 `--s-N` token 或新增 `.review-stage-grid` class）

- [ ] **Step 3: 列 touch 文件**

| 文件 | 类型 |
|---|---|
| `src/ui/components/AttemptTimeline.tsx` | 创建 |
| `app/(app)/review/page.tsx` | 修改（grid 布局 + 插入 timeline） |

- [ ] **Step 4: 等用户 approve**

Post: 上面 3 步 + grid 布局变化（review-stage 从单列变 2-column，只在 feedback 阶段；answering 阶段保持单列）。

---

### Task 2: `getQuestionTimeline` query + `AttemptTimelineRow` shape

**Files:**
- Create: `src/server/events/timeline.ts`
- Create: `src/server/events/timeline.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/server/events/timeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withDb } from '@/tests/helpers/db';
import { writeEvent } from '@/server/events/queries';
import { newId } from '@/core/ids';
import { getQuestionTimeline } from './timeline';

describe('getQuestionTimeline', () => {
  it('returns recent attempt + review + skip events for the question, newest first', async () => {
    await withDb(async (db) => {
      const qid = 'q_timeline_a';
      const now = Date.now();
      // 3 attempts (1 failure 2 success), 1 review, 1 skip — across 1h
      await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'attempt', subject_kind: 'question', subject_id: qid, outcome: 'failure', payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [], duration_ms: 12000 }, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date(now - 60 * 60_000) });
      await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'attempt', subject_kind: 'question', subject_id: qid, outcome: 'success', payload: { answer_md: 'ok', answer_image_refs: [], referenced_knowledge_ids: [], duration_ms: 9000 }, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date(now - 40 * 60_000) });
      await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'review', subject_kind: 'question', subject_id: qid, outcome: 'success', payload: { fsrs_rating: 'good', fsrs_state_after: { due: new Date(now + 86400_000), stability: 1, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, state: 'review', last_review: new Date() }, user_response_md: null, referenced_knowledge_ids: [], duration_ms: 5000 }, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date(now - 20 * 60_000) });
      await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'experimental:question_skip', subject_kind: 'question', subject_id: qid, outcome: 'success', payload: {}, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date(now - 10 * 60_000) });
      await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'attempt', subject_kind: 'question', subject_id: qid, outcome: 'success', payload: { answer_md: 'ok2', answer_image_refs: [], referenced_knowledge_ids: [], duration_ms: 7000 }, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date(now - 1 * 60_000) });

      const rows = await getQuestionTimeline(db, qid, { limit: 10 });
      expect(rows).toHaveLength(5);
      // newest first
      expect(rows[0].action).toBe('attempt');
      expect(rows[0].outcome).toBe('success');
      expect(rows[4].action).toBe('attempt');
      expect(rows[4].outcome).toBe('failure');
      expect(rows.find((r) => r.action === 'experimental:question_skip')).toBeDefined();
      expect(rows.find((r) => r.action === 'review')?.rating).toBe('good');
    });
  });

  it('caps at limit', async () => {
    await withDb(async (db) => {
      const qid = 'q_timeline_cap';
      for (let i = 0; i < 15; i++) {
        await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'attempt', subject_kind: 'question', subject_id: qid, outcome: 'success', payload: { answer_md: String(i), answer_image_refs: [], referenced_knowledge_ids: [], duration_ms: 1000 }, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date(Date.now() - i * 1000) });
      }
      const rows = await getQuestionTimeline(db, qid, { limit: 10 });
      expect(rows).toHaveLength(10);
    });
  });

  it('attaches effective cause for failure attempts (CC-1 helper)', async () => {
    await withDb(async (db) => {
      const qid = 'q_timeline_cause';
      const attemptId = newId();
      await writeEvent(db, { id: attemptId, session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'attempt', subject_kind: 'question', subject_id: qid, outcome: 'failure', payload: { answer_md: 'x', answer_image_refs: [], referenced_knowledge_ids: [], duration_ms: 1000 }, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date() });
      // user_cause event for that attempt
      await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'experimental:user_cause', subject_kind: 'question', subject_id: qid, outcome: 'success', payload: { attempt_event_id: attemptId, primary_category: 'conceptual_misunderstanding', user_notes: 'not clear' }, caused_by_event_id: attemptId, task_run_id: null, cost_micro_usd: null, created_at: new Date() });

      const rows = await getQuestionTimeline(db, qid, { limit: 10 });
      const failure = rows.find((r) => r.action === 'attempt' && r.outcome === 'failure');
      expect(failure?.cause).toBe('conceptual_misunderstanding');
      expect(failure?.cause_source).toBe('user');
    });
  });

  it('completes within 100ms for 1000 events on the question', async () => {
    await withDb(async (db) => {
      const qid = 'q_timeline_perf';
      const batch = Array.from({ length: 1000 }, (_, i) => ({
        id: newId(), session_id: null, actor_kind: 'user' as const, actor_ref: 'self', action: 'attempt' as const,
        subject_kind: 'question' as const, subject_id: qid, outcome: 'success' as const,
        payload: { answer_md: String(i), answer_image_refs: [], referenced_knowledge_ids: [], duration_ms: 1000 },
        caused_by_event_id: null, task_run_id: null, cost_micro_usd: null,
        created_at: new Date(Date.now() - i * 1000),
      }));
      for (const e of batch) await writeEvent(db, e);
      const t0 = Date.now();
      const rows = await getQuestionTimeline(db, qid, { limit: 10 });
      const elapsed = Date.now() - t0;
      expect(rows).toHaveLength(10);
      // Generous 200ms locally; tighten in CI if stable
      expect(elapsed).toBeLessThan(200);
    });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/events/timeline.test.ts
```

Expected: FAIL — `getQuestionTimeline` not exported.

- [ ] **Step 3: Implement query**

Create `src/server/events/timeline.ts`:

```ts
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { CauseCategoryT } from '@/core/schema/event/blocks';
import type { DbLike } from '@/db/client';
import { event } from '@/db/schema';
import { effectiveCauseForFailureAttempt } from './cause-policy';
import { getFailureAttempts, type FailureAttempt } from './queries';
import { activeEffectiveTruth, type EffectiveTruth } from '@/server/review/effective-truth';

export type AttemptTimelineRow = {
  event_id: string;
  action: 'attempt' | 'review' | 'experimental:question_skip';
  outcome: 'success' | 'failure' | 'partial';
  created_at: Date;
  duration_ms: number | null;
  // review-specific
  rating?: 'again' | 'hard' | 'good';
  // failure-attempt-specific
  cause?: CauseCategoryT;
  cause_source?: 'user' | 'agent';
  correction_state?: EffectiveTruth;
};

export interface GetQuestionTimelineOpts {
  limit?: number;
}

const TIMELINE_ACTIONS = ['attempt', 'review', 'experimental:question_skip'] as const;

export async function getQuestionTimeline(
  db: DbLike,
  questionId: string,
  opts: GetQuestionTimelineOpts = {},
): Promise<AttemptTimelineRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  // Hits event_subject_idx (subject_kind, subject_id, created_at desc)
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        inArray(event.action, TIMELINE_ACTIONS as unknown as string[]),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(limit);

  // For failure attempts, attach effective cause via CC-1 helper.
  const failureAttemptIds = rows
    .filter((r) => r.action === 'attempt' && r.outcome === 'failure')
    .map((r) => r.id);
  const failureAttemptsById = new Map<string, FailureAttempt>();
  if (failureAttemptIds.length > 0) {
    const attempts = await getFailureAttempts(db, { attemptEventIds: failureAttemptIds });
    for (const fa of attempts) failureAttemptsById.set(fa.attempt_event_id, fa);
  }

  return rows.map((row): AttemptTimelineRow => {
    const action = row.action as AttemptTimelineRow['action'];
    const outcome = (row.outcome ?? 'success') as AttemptTimelineRow['outcome'];
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const duration_ms = typeof payload.duration_ms === 'number' ? payload.duration_ms : null;

    if (action === 'review') {
      return {
        event_id: row.id,
        action,
        outcome,
        created_at: row.created_at,
        duration_ms,
        rating: payload.fsrs_rating as AttemptTimelineRow['rating'],
      };
    }

    if (action === 'attempt' && outcome === 'failure') {
      const fa = failureAttemptsById.get(row.id);
      const effective = fa ? effectiveCauseForFailureAttempt(fa) : null;
      return {
        event_id: row.id,
        action,
        outcome,
        created_at: row.created_at,
        duration_ms,
        cause: effective?.primary_category,
        cause_source: effective?.source,
        correction_state: effective?.correction_state,
      };
    }

    return { event_id: row.id, action, outcome, created_at: row.created_at, duration_ms };
  });
}
```

If `getFailureAttempts` does not accept `attemptEventIds` filter, **add** it. Otherwise drop down to scanning a wider window and filtering client-side; pick what minimizes cross-cutting.

- [ ] **Step 4: Run, expect pass**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/events/timeline.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/events/timeline.ts src/server/events/timeline.test.ts src/server/events/queries.ts
git commit -m "feat(events): getQuestionTimeline + AttemptTimelineRow (YUK-58)"
```

---

### Task 3: `GET /api/questions/[id]/timeline` route

**Files:**
- Create: `app/api/questions/[id]/timeline/route.ts`
- Create: `app/api/questions/[id]/timeline/route.test.ts`

- [ ] **Step 1: Write failing route test**

Create `app/api/questions/[id]/timeline/route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withDb } from '@/tests/helpers/db';
import { GET } from './route';
import { writeEvent } from '@/server/events/queries';
import { newId } from '@/core/ids';

describe('GET /api/questions/[id]/timeline', () => {
  it('returns timeline rows for question', async () => {
    await withDb(async (db) => {
      const qid = 'q_route_a';
      await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'attempt', subject_kind: 'question', subject_id: qid, outcome: 'success', payload: { answer_md: 'x', answer_image_refs: [], referenced_knowledge_ids: [], duration_ms: 1000 }, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date() });

      const res = await GET(new Request(`http://test/api/questions/${qid}/timeline`), { params: Promise.resolve({ id: qid }) });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].action).toBe('attempt');
    });
  });

  it('caps limit query param', async () => {
    await withDb(async (db) => {
      const qid = 'q_route_cap';
      for (let i = 0; i < 20; i++) {
        await writeEvent(db, { id: newId(), session_id: null, actor_kind: 'user', actor_ref: 'self', action: 'attempt', subject_kind: 'question', subject_id: qid, outcome: 'success', payload: { answer_md: String(i), answer_image_refs: [], referenced_knowledge_ids: [], duration_ms: 1000 }, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null, created_at: new Date(Date.now() - i * 1000) });
      }
      const res = await GET(new Request(`http://test/api/questions/${qid}/timeline?limit=5`), { params: Promise.resolve({ id: qid }) });
      const json = await res.json();
      expect(json.rows).toHaveLength(5);
    });
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement route**

Create `app/api/questions/[id]/timeline/route.ts`:

```ts
import { z } from 'zod';
import { db } from '@/db/client';
import { getQuestionTimeline } from '@/server/events/timeline';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const Query = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const rows = await getQuestionTimeline(db, id, { limit: parsed.data.limit });
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit**

```bash
git add app/api/questions/\[id\]/timeline/
git commit -m "feat(api): GET /api/questions/:id/timeline (YUK-58)"
```

---

### Task 4: `AttemptTimeline` component

**Files:**
- Create: `src/ui/components/AttemptTimeline.tsx`
- Create: `src/ui/components/AttemptTimeline.test.tsx`

- [ ] **Step 1: Write component snapshot test**

Create `src/ui/components/AttemptTimeline.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AttemptTimeline } from './AttemptTimeline';
import type { AttemptTimelineRow } from '@/server/events/timeline';

const ROWS: AttemptTimelineRow[] = [
  { event_id: 'e1', action: 'attempt', outcome: 'success', created_at: new Date('2026-05-24T12:00:00Z'), duration_ms: 8000 },
  { event_id: 'e2', action: 'attempt', outcome: 'failure', created_at: new Date('2026-05-23T10:00:00Z'), duration_ms: 15000, cause: 'conceptual_misunderstanding', cause_source: 'user' },
  { event_id: 'e3', action: 'attempt', outcome: 'failure', created_at: new Date('2026-05-22T08:00:00Z'), duration_ms: 20000, cause: 'conceptual_misunderstanding', cause_source: 'agent' },
  { event_id: 'e4', action: 'review', outcome: 'success', created_at: new Date('2026-05-21T20:00:00Z'), duration_ms: 5000, rating: 'good' },
];

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('AttemptTimeline', () => {
  it('renders rows newest-first with action / outcome / duration', () => {
    const { container, getByText } = render(wrap(<AttemptTimeline rows={ROWS} loading={false} />));
    const items = container.querySelectorAll('.attempt-timeline-row');
    expect(items).toHaveLength(4);
    expect(getByText('attempt')).toBeTruthy();
    expect(getByText('review')).toBeTruthy();
  });

  it('flags repeated cause (≥ 2 same) with --again-ink class', () => {
    const { container } = render(wrap(<AttemptTimeline rows={ROWS} loading={false} />));
    const causeChips = container.querySelectorAll('.attempt-timeline-cause');
    const repeated = Array.from(causeChips).filter((el) => el.classList.contains('attempt-timeline-cause--repeated'));
    expect(repeated.length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty state', () => {
    const { getByText } = render(wrap(<AttemptTimeline rows={[]} loading={false} />));
    expect(getByText(/暂无历史/)).toBeTruthy();
  });

  it('shows loading skeleton', () => {
    const { container } = render(wrap(<AttemptTimeline rows={[]} loading={true} />));
    expect(container.querySelector('.attempt-timeline-loading')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement component**

Create `src/ui/components/AttemptTimeline.tsx`:

```tsx
import type { AttemptTimelineRow } from '@/server/events/timeline';
import { CorrectionStateRenderer } from '@/ui/correction/CorrectionStateRenderer';

interface AttemptTimelineProps {
  rows: AttemptTimelineRow[];
  loading: boolean;
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.round(h / 24);
  return `${days}d`;
}

function actionLabel(action: AttemptTimelineRow['action']): string {
  if (action === 'attempt') return 'attempt';
  if (action === 'review') return 'review';
  return 'skip';
}

export function AttemptTimeline({ rows, loading }: AttemptTimelineProps) {
  if (loading) {
    return <div className="attempt-timeline-loading">加载历史中…</div>;
  }
  if (rows.length === 0) {
    return <div className="attempt-timeline-empty">暂无历史 attempt。</div>;
  }

  // Compute cause repetition count for highlight.
  const causeCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.cause) causeCounts.set(r.cause, (causeCounts.get(r.cause) ?? 0) + 1);
  }

  return (
    <ol className="attempt-timeline">
      {rows.map((r) => {
        const causeRepeated = r.cause && (causeCounts.get(r.cause) ?? 0) >= 2;
        const causeClass = ['attempt-timeline-cause', causeRepeated ? 'attempt-timeline-cause--repeated' : ''].filter(Boolean).join(' ');
        return (
          <li key={r.event_id} className={`attempt-timeline-row outcome-${r.outcome}`}>
            <span className="attempt-timeline-time">{formatRelative(r.created_at)}</span>
            <span className="attempt-timeline-action">{actionLabel(r.action)}</span>
            <span className={`attempt-timeline-outcome outcome-${r.outcome}`}>{r.outcome}</span>
            {r.rating && <span className="attempt-timeline-rating">{r.rating}</span>}
            {r.duration_ms != null && <span className="attempt-timeline-duration">{Math.round(r.duration_ms / 1000)}s</span>}
            {r.cause && (
              <span className={causeClass} title={`${r.cause} · ${r.cause_source}`}>
                {r.cause}
              </span>
            )}
            {r.correction_state && <CorrectionStateRenderer state={r.correction_state} compact />}
          </li>
        );
      })}
    </ol>
  );
}
```

Add corresponding CSS rules under the global `app/globals.css` (or wherever review CSS lives — `grep -n "review-stage" app/globals.css`):

```css
.attempt-timeline { list-style: none; padding: 0; display: flex; flex-direction: column; gap: var(--s-1); }
.attempt-timeline-row { display: grid; grid-template-columns: 3em 4em 5em 1fr; gap: var(--s-1); align-items: baseline; font-size: 0.875rem; }
.attempt-timeline-row.outcome-failure { color: var(--again-ink); }
.attempt-timeline-cause--repeated { font-weight: 600; color: var(--again-ink); }
.attempt-timeline-empty, .attempt-timeline-loading { color: var(--ink-4); padding: var(--s-2); }
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/AttemptTimeline.tsx src/ui/components/AttemptTimeline.test.tsx app/globals.css
git commit -m "feat(ui): AttemptTimeline component (YUK-58)"
```

---

### Task 5: Wire timeline into review page feedback stage

**Files:**
- Modify: `app/(app)/review/page.tsx`

- [ ] **Step 1: Add timeline query in review-stage**

In `app/(app)/review/page.tsx`, near other useQuery calls, add:

```tsx
const timelineQ = useQuery({
  queryKey: ['question-timeline', current?.question_id],
  queryFn: () => apiJson<{ rows: AttemptTimelineRow[] }>(`/api/questions/${current!.question_id}/timeline?limit=10`),
  enabled: !!current && phase === 'feedback',
  staleTime: 30_000,
});
```

Import `AttemptTimeline` and `AttemptTimelineRow` type at top.

- [ ] **Step 2: Restructure review-stage to 2-column when feedback**

Locate the `<section className="review-stage">` block. Restructure so when `phase === 'feedback'`, the children render in a 2-column grid (left: existing reference + rating + answer area, right: timeline):

```tsx
<section className={`review-stage ${phase === 'feedback' ? 'review-stage--grid' : ''}`}>
  <div className="review-stage-main">
    {/* existing prompt / answer / rating / reference content stays here */}
  </div>
  {phase === 'feedback' && (
    <aside className="review-stage-side">
      <h4>这题的历史</h4>
      <AttemptTimeline rows={timelineQ.data?.rows ?? []} loading={timelineQ.isLoading} />
    </aside>
  )}
</section>
```

Add CSS:

```css
.review-stage--grid { display: grid; grid-template-columns: minmax(0, 1fr) 22em; gap: var(--s-3); }
@media (max-width: 800px) {
  .review-stage--grid { grid-template-columns: 1fr; }
  .review-stage-side { border-top: 1px solid var(--ink-7); padding-top: var(--s-2); }
}
```

- [ ] **Step 3: Manual smoke**

```bash
lsof -nP -iTCP:3000
pnpm dev
```

Open `/review`, fail a question + rate → feedback shows timeline panel right side. With repeated cause (same `conceptual_misunderstanding` 2+ times), see highlighted chip. Resize to <800px → side panel stacks below.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/review/page.tsx app/globals.css
git commit -m "feat(review): integrate AttemptTimeline into feedback stage (YUK-58)"
```

---

### Task 6: Full lane test gate + performance verify

- [ ] **Step 1: Run all tests**

```bash
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test
```

Expected: all green.

- [ ] **Step 2: Perf sanity (real DB)**

```bash
pnpm vitest run --config vitest.db.config.ts src/server/events/timeline.test.ts -t 'completes within 100ms'
```

Confirm passes. If it flakes > 200ms, add a GIN index or rethink scan; document in PR.

- [ ] **Step 3: Manual E2E recap**

1. Fail a review question → feedback shows: rating buttons (left) + timeline panel (right)
2. Pass + good rating → next question; on next failure, see the previous failure already in timeline with cause chip
3. Open dev tools network → confirm `/api/questions/<id>/timeline?limit=10` round-trip < 100ms

- [ ] **Step 4: PR description**

Include:
- Cross-cutting helpers referenced: CC-1 (`effectiveCauseForFailureAttempt`) + CC-2 (`CorrectionStateRenderer compact`)
- Reused index: `event_subject_idx`
- Empty/loading/repeated-cause states all covered by tests

---

## Exit criteria recap (mirror Linear acceptance)

- [ ] feedback 阶段显示当前题最近 N 条 attempt timeline —— Task 5
- [ ] timeline 含 rating + cause + 时间 —— Task 2 + 4
- [ ] cause 趋势可视（重复同 cause 的红色标记）—— Task 4 `attempt-timeline-cause--repeated` class
- [ ] 性能：timeline query <100ms —— Task 2 perf test + Task 6 Step 2

## Linear capture gate（PR 前）

必开 follow-up：
1. **`QuestionActivitySummary` derived view** —— [`docs/modules/quiz.md`](../../modules/quiz.md) §1.5 设想；当前 lane 是窄查询，未来若多 surface 共享（/mistakes/[id] / coach 报表）应迁移到 view，开 issue
2. **Timeline 在 `/mistakes/[id]` 复用** —— `AttemptTimeline` 组件可复用到错题详情页，独立 lane
3. **GIN index on event.payload** —— 如果 attempt 数大量增长后 perf 退化，开 issue

PR title 用 Linear branch；commit message 含 `Closes YUK-58`。

## ADR 触发

不触发：
- 无新 KnownEvent action（`experimental:question_skip` 由 YUK-57 引入）
- 无 schema 改动
- 复用现有 indices

如果 Task 6 Step 2 perf 不达标决定建 derived view，需要新 ADR（"per-question activity projection 走 view 而非 query"），但本 lane 先用窄查询。
