# YUK-58 — Review feedback attempt timeline (P2.3)

**Linear**: YUK-58
**Parent**: YUK-18 Review session UX polish
**Branch**: `yuk-58-review-attempt-timeline`
**Cascaded from**: YUK-57 tip (`319e0f9`)

## Goal

在 review 答题 feedback 阶段，下方挂一个 timeline panel：列出当前题目最近 N 次 attempt
+ review，每条带 timestamp / rating / cause / outcome / duration。让用户判定 cause
趋势（例如反复 `careless_mistake` → 应换策略而非难度）。

## Architecture

```
app/api/questions/[id]/timeline/route.ts   GET → JSON envelope
  └─ src/server/events/queries.ts          getQuestionTimeline(db, qid, limit)
                                            ↳ 复用 getEffectiveTruths + takeActiveRows

app/(app)/review/page.tsx                  feedback phase 加 <AttemptTimeline />
src/ui/components/AttemptTimeline.tsx      inline component（snapshot-tested via renderToString）
```

### Why server route + client component

- Review page 当前只持有 plan queue（PlanQueueItem），不含历史 attempt。要 timeline 必须查 DB。
- Timeline 是「按 question_id 聚合」，与 review session 解耦 —— 适合独立 route。
- 客户端用 TanStack Query `useQuery` 按 `current.question_id` 拉数据，与 plan/judge 数据并列。

### Auth

`middleware.ts` 已经强制 `/api/*` 校验 `x-internal-token`。timeline route 不写白名单 → 走默认 token 保护。`/api/health` 是唯一豁免，本路由不属于。

## Data shape (route response)

```ts
// GET /api/questions/[id]/timeline?limit=10
type TimelineEvent =
  | {
      kind: 'attempt';
      event_id: string;
      created_at_sec: number;              // unix seconds (numeric, NOT Date / ISO string)
      outcome: 'success' | 'failure' | 'partial';
      duration_ms: number | null;
      cause: { primary: string; confidence: number | null } | null;  // from chained judge
    }
  | {
      kind: 'review';
      event_id: string;
      created_at_sec: number;
      fsrs_rating: 'again' | 'hard' | 'good';
      outcome: 'success' | 'failure';
      duration_ms: number | null;
    };

type TimelineResponse = {
  question_id: string;
  events: TimelineEvent[];                 // ordered desc by created_at, max `limit`
  computed_at_sec: number;
};
```

### Timestamp 约定（PR #122 stale 项 fix）

仓内既有 route（`app/api/records/[id]`, `app/api/learning-sessions/[id]`）一律返回
`Math.floor(.getTime() / 1000)` 即 unix seconds 的 **number**。本 route 沿用，**不返回
ISO string**，更不返回 `Date`。客户端可直接 `new Date(sec * 1000)` 或用 `Intl` 格式化。
Zod boundary 用 `z.number().int().nonnegative()`。

理由：JSON 不能传 `Date`；如果用 string `z.string().datetime()` 反而引入"是否带 Z / 毫秒
精度 / parse 失败"等额外复杂度。仓内已统一 number，保持一致。

## Query strategy

```ts
// src/server/events/queries.ts
export async function getQuestionTimeline(
  db: DbLike,
  questionId: string,
  limit = 10,
): Promise<QuestionTimelineEntry[]>
```

1. `WHERE subject_kind='question' AND subject_id=$1 AND action IN ('attempt','review')` —
   命中现有 `event_subject_idx` (`subject_kind, subject_id, created_at DESC`)。
2. `ORDER BY created_at DESC LIMIT limit*3`（为 correction filter 留 headroom）。
3. 用现有 `takeActiveRows` 过滤掉 retracted / superseded。
4. 对 attempt 行二次查询 chained judge（`caused_by_event_id IN (...)` AND `action='judge'`），
   提取 `payload.cause.primary_category`。命中现有 `event_caused_by_idx`。
5. 返回时把 `created_at` → unix seconds。

**性能 budget**：单题 10 条 +chained judges 一轮 → 2 query / <30ms 在本地 testcontainer
正常 dataset 应远低于 100ms 阈值。timeline 不在请求路径热点，不加新 index。

## File structure

**新建**:
- `app/api/questions/[id]/timeline/route.ts` (新 `app/api/questions/` 子树)
- `app/api/questions/[id]/timeline/route.test.ts` (DB integration)
- `src/ui/components/AttemptTimeline.tsx`
- `src/ui/components/AttemptTimeline.test.tsx` (renderToString snapshot)
- `docs/superpowers/plans/2026-05-24-yuk-58-review-attempt-timeline.md` (本文)

**修改**:
- `src/server/events/queries.ts` (加 `getQuestionTimeline`)
- `app/(app)/review/page.tsx` (feedback phase JSX 插 timeline panel)
- `app/globals.css` (加 `.attempt-timeline` 小段 scoped css)

**不动**:
- Schema / migration / drizzle config（不加新表 / 新 index — 现有 `event_subject_idx` 够用）
- `subjectProfiles`（不动 audit:profile 覆盖面）
- `audit-schema-allowlist.json`（不引入新字段 → 不需 allowlist）

## UI design pre-flight

- **本 lane 没专门 design doc**。属于「在 feedback phase 加 panel」——参照 `docs/design/loom-design-v2.1/`
  的 review-stage 既有结构（`feedback-split`, `cause-row`, `label-mono`）。
- **组件类型**：inline panel（紧跟 `cause-row` 下方，在 `lastJudge` 面板**之前**），与 feedback
  阶段同卡片，不是 modal / drawer / route。
- **touch 文件**：
  - 新建 `src/ui/components/AttemptTimeline.tsx`（创建）
  - 修改 `app/(app)/review/page.tsx`（在 feedback JSX 插）
  - 修改 `app/globals.css`（加 `.attempt-timeline` 小区段 ~30 行）
- **primitive 复用**：`Badge` (`good`/`again`/`hard`/`info`/`neutral` tones，**不发明新 tone**) + 既有 typography
  (`label-mono`, `--ink-4`, `--s-2/3`, `--r-3`) + `CauseBadge` 已存在但 timeline 行内紧凑度更高，
  自绘小 chip（仍走 `Badge` primitive）。
- **不引入新 design token / 新 primitive**。

### Cause 趋势可视

ticket 写「重复同 cause 的红色标记」。设计落点：

- 对前 N 条 attempt 的 cause 做频次统计，若同一 cause 出现 ≥ 2 次，在该 cause 标签上加
  `tone="again"` (红)；否则 `tone="info"` (中性蓝)。
- 这是**前端纯派生**，route 不返回额外字段。简单可维护。

## Open questions

- **没有**。所有数据源 + index 已就绪，无新 schema / migration / token / capability。
- 唯一边界决策（unix seconds vs ISO string）已在本文锁定。

## Tasks (TDD)

1. **[red→green] server query**
   - `src/server/events/queries.test.ts` 加 `getQuestionTimeline` cases：
     - 空 → `events: []`
     - attempt + review 混合，desc 顺序
     - chained judge cause 注入 attempt
     - retracted attempt 不出现
     - limit 起作用

2. **[red→green] route handler**
   - `app/api/questions/[id]/timeline/route.test.ts`：
     - 200 + 正确 shape；`created_at_sec` 是 number
     - `limit` query param parse + clamp
     - 不存在 question_id 仍返回 200（empty events）—— 与 echo events route 一致简单语义

3. **[red→green] AttemptTimeline component**
   - `src/ui/components/AttemptTimeline.test.tsx`：
     - 空 events → 显示 `暂无历史记录` empty state
     - 多条混合 → 渲染 timestamp / rating / cause 各列
     - cause 重复 → 重复条目带 `tone='again'` 标识（class / aria）

4. **[wire] review page**
   - 在 feedback phase `cause-row` 与 `JudgeResultPanel` 之间插入
     `<AttemptTimeline questionId={current.question_id} />`
   - paused 时不渲染（外层 `!isPaused` 守卫已经在 feedback JSX 树外，沿用）

5. **[css]** `app/globals.css` 加 `.attempt-timeline` 段。

6. **Pre-merge gate**: typecheck / lint / audit (schema/partition/profile) / pnpm test 全绿。

## Risk

- **flake**：timeline test 用 testcontainer Postgres，已是 db config，串行 fork → 低风险。
- **stale 数据**：feedback 切到下一题时 `current.question_id` 变 → React Query auto re-fetch
  会工作；如果有问题用 `queryKey: ['question-timeline', questionId]`。
- **过大 N**：硬 cap `limit ≤ 50`，default 10。
- **regression review page**：YUK-57 改了 mount / pause / skip 逻辑。我只在 feedback JSX
  树内加 panel，不动 state / hook / handler / sessionStatus union。

## Rollback

- Revert：删 4 个新文件 + 在 review page / queries.ts / globals.css 撤回 hunk。
- 无 schema / migration / capability registry 修改 → 零 DB rollback 风险。

## Linear capture gate

完成后 actionable follow-up：
- 若 timeline 上线后用户反馈想要 sparkline 趋势图 → 单独 issue（本 ticket spec 只要 list / chip）
- 若发现 `QuestionActivitySummary` derived view 应该 promote 出来给多处复用 → 单独 issue

进程内不创建（属于猜测性 follow-up），由 orchestrator 收到报告再决定。

## Exit criteria

- ✅ `pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test` 全绿
- ✅ 在 feedback phase 看到当前题最近 10 条 attempt timeline
- ✅ Timeline 含 rating + cause + 时间 + outcome
- ✅ 重复 cause 视觉标红
- ✅ Timeline query <100ms（DB test 内验证）
- ✅ created_at 全程 `number` (unix seconds)，没有 Date / ISO string 漂移
