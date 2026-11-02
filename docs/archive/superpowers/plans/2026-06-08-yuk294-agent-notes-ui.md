# YUK-294 — AgentNotes 看板（"AI 观察" 只读旁观块）Lane Plan

Worktree: `/Users/yukoval/yukoval-projects/the-learning-project/.claude/worktrees/yuk294-agent-notes-ui`
Branch: `yuk-294-agent-notes-board`
本 plan 现场勘察源码后写成（勘察A 移植模式 + 勘察B 设计规格 + 实读源码核对）。设计 mock 的虚构词表一律映射到真实数据合同；只读铁律全程生效。

> **⚠️ 实现 lane 第一动作（BLOCKER，critic round-1 否决修复）：重新切分支基线。**
> 当前 worktree 的 `yuk-294-agent-notes-board` **不是**从 fresh main 切的——它误从 in-flight 的 `yuk-288-question-bank-ui-s1`（题库 UI S1 stack）派生。实证：
> - `git log -1` HEAD = `66264f02 fix(questions): bot review round (Refs YUK-281)`；
> - `git rev-list --count main..yuk-294-agent-notes-board` = **67** 个未合并 commit（属 YUK-280/281/282/275/288 题库链）；
> - `git branch --contains 66264f02` 同时返回 `yuk-288-question-bank-ui-s1` 与 `yuk-294-agent-notes-board`，证明 YUK-294 是从 YUK-288 分出的，不是从 main。
> - `app/globals.css` 行数：main = **10112**，yuk-288 = **11066**，被污染的 worktree = **10879**——所以本 plan 早期版本里所有对 globals.css 的行号锚点是对着 10879 行的污染文件读的，clean main 上行号会偏。
>
> 这正是 project memory `feedback_lane_plan_pattern.md` 点名的 stale/resurrect 反模式（PR #122 实证）。**实现 lane 启动时必须先把分支基线重置到 `main`（a9a12faf）再动手**：
> ```bash
> cd /Users/yukoval/yukoval-projects/the-learning-project/.claude/worktrees/yuk294-agent-notes-ui
> git fetch origin
> git reset --hard main          # 或 git checkout -B yuk-294-agent-notes-board main
> git log -1 --oneline           # 必须显示 a9a12faf（main HEAD），不是 66264f02
> git rev-list --count main..HEAD  # 必须为 0
> ```
> 重置后 §0 / §6 的所有行号锚点已**重新对 clean main（a9a12faf）核对过**，见 §0 表与 §6 token 锚点（已标 "main 核对"）。YUK-294 是独立 stand-alone lane，**不**建在题库栈之上。

---

## 0. 勘察核对结论（落地前必须知道的真相，覆盖报告里的推断）

> **基线声明（critic round-1 修复）**：下列行号锚点已**全部重新对 clean main（a9a12faf）核对**（`git show main:<file>`），不再依赖被污染的 worktree（参见文首 BLOCKER）。逐条已核：globals.css `--paper-sunk` L132 / `--paper-raised` L133 / `--ink-4` L139 / `--ink-5` L140 / `--line-strong` L143 / `--coral` L146 / `--coral-line` L150 / `--coral-ink` L151 / `--hard` L158 / `--hard-line` L160 / `--good` L163 / `--good-line` L165 / `--info` L168 / `--info-line` L253 / `--ls-wide` L204 / `--r-pill` L223 / `--dur-base` L235 / `--ease-out` L114/L231；`.today-loom .tone-chip-{info,coral,good,hard,neutral}` L7995-8019；`.badge .dot.pulse` + `@keyframes loom-pulse-dot` L5813-5816；today 页 `dash-grid` 开 L301 收 ~L341、WeekHeat 注释起 L344、`'use client'` L1；LoomIcon `arrow` L29（左右）、`tag` L44、`sparkle` L37、无 `chevronDown`；notes.ts `subject_kind='query'` L96、读路径 `target_agents @> [for_agent]` 强制过滤。clean main 的 `app/globals.css` = 10112 行、当前 0 个 `.an-` 类。

实读源码后，相对两份勘察报告有几处必须以代码为准的修正：

1. **CSS 不是 co-located，是单一 `app/globals.css`**。`app/globals.css` 只有两条 `@import`（fonts + tailwindcss，L1/L3），没有任何 per-page `.css` 文件。所有 `today-loom` / `ev-lane` / `.tone-chip-*` 类都在 globals.css 里，按 **per-page wrapper class** 作用域隔离（`.today-loom .x`、`.events-loom .x`、`.knowledge-loom .x`）。→ 本 feature 的所有 `.an-*` CSS 必须 append 到 `app/globals.css`，并 scope 在统一 wrapper class 下（见 §6）。
2. **`.tone-chip-{info,coral,good,hard,neutral}` 在 globals.css L7995-8019（main 核对）是 scoped 在 `.today-loom` 下的，不是全局**。设计规格说"REUSE 既有 tone-chip 不要重定义"——在 Today 紧凑块里（位于 `.today-loom main` 内）确实能复用；但**全屏页 `/agent-notes` 不在 `.today-loom` 下，拿不到这些类**。→ 决策：signal chip 的 tone-chip 着色规则在本 feature 用统一 `.an-*` 作用域重新声明（见 §6 风险点 R1），不依赖 `.today-loom` 继承，保证两个视图视觉一致。
3. **`LoomIcon` 没有 `chevronDown`**（main 核对：ICONS 全表无该键；`arrow` L29 是左右箭头，`tag` L44、`sparkle` L37 存在）。设计规格 §1a 用到 `chevronDown`。→ 决策：在 `LoomIcon` 的 `ICONS` 表里**补一个 `chevronDown` 键**（feather `m6 9 6 6 6-6` 风格），不是 hack 旋转 `arrow`（设计要的是上下箭头语义，`arrow` 是左右箭头；旋转 90° 视觉别扭）。`arrow`（L29，左右）继续用于 route flow / 看全部 pill。
4. **`/events/:id` 路由真实存在**（main 核对：`app/(app)/events/[id]/page.tsx` 在 main 即存在），导航惯例是 `router.push('/events/' + id)`（events 页实证）。→ evidence 跳转用 `router.push('/events/' + ref.id)`，不是设计 mock 的 `go("events/" + id)`。
5. **真实 `readAgentNotes` 强制按 `for_agent` 做 jsonb containment 过滤**（main 核对：notes.ts 读路径 `target_agents @> [for_agent]` + 过期过滤 + `ORDER BY created_at DESC, id DESC` + limit clamp）。看板要"全部 agent 的 note"，没有这个读路径。→ YUK-294 既定项：加无 `for_agent` 过滤的读变体（见 §3）。`AgentNote` 返回类型已含看板所需全部字段，无需改 schema。
6. **真实数据合同里没有 `from`/`to`/`fresh`/`when`/`evidence{id,label}`/`ttl` 这些字段**——它们是设计 mock 的虚构。真实字段是 `source_task_kind`（单值，相当于 mock 的 `from`）、`target_agents[]`（相当于 mock 的 `to`）、`refs[]{kind,id}` + `caused_by_event_id`（相当于 mock 的 `evidence`）、`created_at`（推 `fresh` / day 分组 / 相对时间）、`expires_at`（推 `ttl`）、`signal_kind`（相当于 mock 的 `signal`）。所有 derive 见 §4。
7. **mock 的 `from`/`to` 键（qverify/dreaming/planning/chat/annotate/ingest）是设计虚构**。真实 `source_task_kind` 现状只有 `quiz_verify` 写（notes.ts 注释 L29 + test fixtures 用 `quiz_verify`/`attribution`），`target_agents` 真实 enum 是 `'dreaming' | 'maintenance' | 'coach'`（notes.ts L45）。YUK-293 后会加 `copilot`/`tagging` 等。→ AGENT_META 必须键到真实 kind 值并对未知键 fallback（见 §5）。
8. 既有 list 块（SessionStrip / AiChangeActivityStrip 等）的折叠先例：events 页用 `useState`（不持久化）；review 页用 localStorage + 日期隔离 key。本 feature 的 collapse/read 是**跨日持久的纯本地态**（设计 §5 明确 key 名），不做日期隔离（旁观信号不是日报概览，read 状态要跨日保留）。

---

## 1. 文件级改动清单（创建 vs 修改）

### 后端 / 数据层（commit ①）

| 文件 | 操作 | 内容 |
|---|---|---|
| `src/server/agents/notes.ts` | **修改** | 加无 `for_agent` 过滤的读变体（见 §3）。保留过期过滤 + newest-first + limit。导出新类型/函数。 |
| `src/server/agents/notes.test.ts` | **修改** | 给新读变体加 DB 测试（覆盖：跨 target_agents 不过滤、过期仍过滤、newest-first、limit）。 |
| `app/api/agents/notes/route.ts` | **创建** | GET handler，zod QuerySchema（`limit?`），调用新读变体，`Response.json({ rows })`，`errorResponse` 兜底。`export const runtime = 'nodejs'`。 |
| `app/api/agents/notes/route.test.ts` | **创建** | route 测试（DB 分区，见 §7）。 |

### UI 层（commit ②）

| 文件 | 操作 | 内容 |
|---|---|---|
| `src/ui/primitives/LoomIcon.tsx` | **修改** | `ICONS` 表补 `chevronDown`（仅一键，feather 下箭头）。 |
| `src/ui/agent-notes/meta.ts` | **创建** | `AGENT_META` / `SIGNAL_META` 真实 kind 键 + fallback 函数（见 §5）。纯数据 + 纯函数，可被 unit 测。 |
| `src/ui/agent-notes/derive.ts` | **创建** | derive 纯函数：`isFresh(created_at, now)`、`deriveTtl(expires_at, now)`、`dayGroupOf(created_at, now)`、`anInlineMd(summary_md)`（轻 markdown）、evidence ref 解析。纯函数，unit 测覆盖（见 §4）。 |
| `src/ui/agent-notes/useAgentReads.ts` | **创建** | 共享 localStorage hook：read-set + open 态。两视图共用同一 storage source of truth（见 §5）。 |
| `src/ui/agent-notes/AgentNoteCard.tsx` | **创建** | 单条 note 卡片（rail/route/body/meta），两视图复用。只读，无任何 accept/dismiss。 |
| `src/ui/agent-notes/AgentNotesBoard.tsx` | **创建** | Today 紧凑块（SectionLabel + Card.an-board + 折叠/peek/empty/foot）。 |
| `app/(app)/agent-notes/page.tsx` | **创建** | 全屏 drill-in 路由（`.page view agentnotes-loom` + back-link + page-head + overview + filter + 按日分组 feed）。 |
| `app/(app)/today/page.tsx` | **修改** | 在 `dash-grid`（L342 `</div>`）之后、WeekHeat 注释（L344）之前 mount `<AgentNotesBoard />`；加对应 TanStack Query。 |
| `app/globals.css` | **修改** | append 全部 `.an-*` 样式 + tone 映射 + 动画，scope 在统一 wrapper class 下（见 §6）。 |

### 测试（随 commit）

| 文件 | 操作 | 内容 |
|---|---|---|
| `src/ui/agent-notes/meta.test.ts` | **创建** | META fallback unit 测（unit 分区，见 §7）。 |
| `src/ui/agent-notes/derive.test.ts` | **创建** | derive 纯函数 unit 测（fresh/ttl/分组/markdown，见 §7）。 |

> 不创建 `/api/agents` 父级 route——只在 `app/api/agents/notes/route.ts` 落 GET。不动 `middleware.ts`（内部 token 由 `apiFetch` 自动带，§2 数据流）。

---

## 2. 数据流

```
浏览器（Today 块 / 全屏页）
  └─ TanStack Query  useQuery({ queryKey: ['agent-notes', <limit>], queryFn })
       └─ apiJson('/api/agents/notes?limit=N')        // apiJson 自动带 x-internal-token
            └─ GET app/api/agents/notes/route.ts
                 └─ zod 校验 limit → readAllAgentNotes(db, { now: new Date(), limit })  // §3 新读变体
                      └─ events 表：action='experimental:agent_note' AND subject_kind='query'
                         AND 过期过滤（expires_at IS NULL OR > now）
                         ORDER BY created_at DESC, id DESC  LIMIT n
                 └─ Response.json({ rows: AgentNote[] })
       └─ rows 经 derive（§4）→ AGENT/SIGNAL_META（§5）→ AgentNoteCard 渲染
       └─ read/open 本地态：useAgentReads()（localStorage，零后端写）
```

- queryKey 约定：紧凑块 `['agent-notes', 'compact']`（limit 取够 4 条以判断 `>3`，实际 cap 3）；全屏页 `['agent-notes', 'full']`（limit 较大，如 50）。两个 query 独立。
- `refetchInterval`：紧凑块可选 `60_000`（与 today 其它块一致）；全屏页不轮询（drill-in，进入即取一次，retry 手动）。
- 错误/空/加载态：紧凑块走 body switch（loading→SkLines / error→ErrorState compact / ok）；全屏页走 `<Stateful>`（skeleton/empty/errorText 三 slot），与 events/today 页一致。

---

## 3. 后端读变体（§1 commit ①核心）

现状 `readAgentNotes(db, { for_agent, now, limit })` 在 SQL 层强制 `target_agents @> [for_agent]`（notes.ts L151）。看板要全部 agent 的 note。

**方案（择一，实现 lane 定，倾向 A）：**

- **A（新函数，推荐）**：新增 `readAllAgentNotes(db, opts: { now: Date; limit?: number }): Promise<AgentNote[]>`，复用同一行→AgentNote 映射逻辑（抽 `rowToAgentNote` 私有 helper，避免两份重复 mapping），SQL 去掉 `target_agents` 谓词，**保留**：`action='experimental:agent_note'` + `subject_kind='query'` + 过期过滤（`NOT (payload ? 'expires_at') OR (payload->>'expires_at') > now`）+ `ORDER BY created_at DESC, id DESC` + `limit` clamp（`<=0 → []`，默认 20）。
- B（改 opts 可选）：`for_agent?` 改可选，缺省时跳过 containment 谓词。改动面小但让单函数行为有分叉，可读性差。

> 倾向 A：读路径职责清晰（"给某 agent 看的 hint" vs "给人看板看全部"语义不同），测试边界干净，不污染既有 dreaming/coach 注入路径。`AgentNote` 返回类型已含 `source_task_kind`/`target_agents`/`refs`/`signal_kind`/`confidence`/`expires_at`/`created_at`——看板渲染所需字段全在，无需扩 schema。

**测试（notes.test.ts 追加 describe('readAllAgentNotes')）：**
- 跨 `target_agents` 不过滤：写 `['coach']` + `['dreaming','maintenance']` 两条，`readAllAgentNotes` 两条都返回。
- 过期仍过滤：复用既有 expired/fresh/forever 三写法，断言 expired 不在结果。
- newest-first + limit：三写 + limit 2 → 长度 2 且顺序最新优先。
- `limit <= 0 → []`。

---

## 4. derive 纯函数（设计 mock 字段 → 真实字段，§1 commit ②）

全部输入真实字段，不解析相对时间字符串 hack。`now` 作参数注入（可测）。

| derive | 输入（真实字段） | 输出 | 规则 |
|---|---|---|---|
| `isFresh(created_at, now)` | `created_at: Date` | `boolean` | `now - created_at < 24h`。替代 mock 的后端 `fresh` 标志。 |
| `deriveTtl(expires_at, now)` | `expires_at?: string` | `{ text: string; soon: boolean } \| null` | 无 `expires_at` → `null`（永不过期，不显示 ttl）。有则相对化：`soon = (expires_at - now) < 48h`；`text` 形如 "约 N 小时后过期" / "约 N 天后过期"（复用/对齐 `formatRelTime` 风格但表达"还剩")。临期（soon）走琥珀 badge，否则 plain。 |
| `dayGroupOf(created_at, now)` | `created_at: Date` | `'today' \| 'yesterday' \| 'earlier'` + label | **按真日期**比对本地日界：同一本地日 → "今天"；前一本地日 → "昨天"；更早 → "更早"。不照搬 mock 的 substring("前天")解析。 |
| `anInlineMd(summary_md)` | `string` | `ReactNode[]` | 轻 markdown，仅 `**bold**`→`<b className="an-body-b">` 与 `` `code` ``→`<code className="an-code">`。正则 `/(\*\*[^*]+\*\*|` + 反引号 + `[^` + 反引号 + `]+` + 反引号 + `)/g`。无任何其它 md（不引 md 库）。 |
| `resolveEvidence(note)` | `refs[]{kind,id}` + `caused_by_event_id?` | `{ label: string; href: string \| null }[]` 或单 primary | 优先 `refs`：`kind==='event'` → `href='/events/'+id`、label=`id`；其它 kind → 能跳则跳（目前仅 event 有页），不能跳则只展示 `kind:id` 文本无 href。`refs` 为空时**兜底** `caused_by_event_id` → 当作一条 `kind='event'` 的 evidence。UI evidence 单按钮渲染首个可跳 ref（或兜底 caused_by），点击 `router.push(href)`。 |

> `created_at` 经 API JSON 序列化是 string，前端 `new Date(row.created_at)` 还原；derive 接 `Date`，调用处负责转换（或 derive 内 `new Date(input)` 容错，与 `formatRelTime` 一致）。

---

## 5. META 映射表（真实 kind 键 + fallback）

`src/ui/agent-notes/meta.ts`。**键到真实值**，未知键一律 fallback（label=原始 kind，中性 tone / 通用 icon）——这是红线（YUK-293 后会冒出 copilot/tagging 等新 kind，UI 不能崩或漏渲染）。

### `AGENT_META`（键 = `source_task_kind` 真实值 + `target_agents` enum 值）

`source_task_kind`（mock `from`）当前真实只有 `quiz_verify` 在写；`target_agents`（mock `to`）真实 enum = `dreaming | maintenance | coach`。两类 id 共用同一查表（route row 里 from 用 `source_task_kind`，to 用 `target_agents[]`）。

| key（真实 kind） | label | icon（LoomIcon 内已存在） | 备注 |
|---|---|---|---|
| `quiz_verify` | 组卷校验 | `quiz` | 现状唯一 writer |
| `dreaming` | 夜间推理 | `moon` | target enum |
| `maintenance` | 维护 | `refresh` | target enum |
| `coach` | 教练 | `target` | target enum |
| `attribution` | 归因 | `mistakes` | test fixture 出现过，预留 |
| `copilot` | Copilot | `copilot` | YUK-293 后预留 |
| `tagging` | 打标 | `tag` | YUK-293 后预留 |

**fallback**：`agentMeta(kind) → AGENT_META[kind] ?? { label: kind, icon: 'sparkle' }`（中性 sparkle，label 显示原始 kind 字符串）。所有 icon 均已在 LoomIcon 表内确认存在（quiz/moon/refresh/target/mistakes/copilot/tag/sparkle）。

### `SIGNAL_META`（键 = `signal_kind` 真实值）

真实 `signal_kind` 是 open vocab（notes.ts test 用 `question_pool_gap`/`pattern_hint`/`coverage_thin`；设计 mock 用 `pool_gap`/`misconception`/`quality`/`offtopic`）。键到**真实可观测值**，并保留设计四 tone 语义映射；未知 → neutral。

| key（真实 signal_kind） | label | tone | 对应设计语义 |
|---|---|---|---|
| `question_pool_gap` | 题池缺口 | `hard` | pool_gap（ochre） |
| `coverage_thin` | 覆盖偏薄 | `hard` | pool_gap 同族 |
| `misconception` | 误解模式 | `info` | misconception（blue） |
| `pattern_hint` | 模式提示 | `info` | misconception 同族 |
| `quality` | 质量信号 | `good` | quality（sage） |
| `offtopic` | 切题反复 | `coral` | offtopic（coral） |

**fallback**：`signalMeta(kind) → SIGNAL_META[kind] ?? { label: kind, tone: 'neutral' }`（中性 tone，label 显示原始 kind）。tone 决定 avatar 三色 + chip tone-chip-X + filter dot 实色。neutral → avatar 保持 base raised/line/ink-3，chip 用 `.tone-chip-neutral`。

> filter bar 的 signalOrder = `Object.keys(SIGNAL_META).filter(k => counts[k] > 0)`，保留 SIGNAL_META 声明顺序，只列实际出现的 signal；**未知 signal**（不在表内但数据里出现）也要进 filter——实现用 `counts` 的实际键并集，未知键标 neutral，保证看板能按任意真实 signal 过滤。

### read/open 本地态（`useAgentReads.ts`）

- `AN_LS_OPEN = 'loom-annotes-open'`：紧凑块 collapse 态，`'1'`=展开，其它=收起，default（未设）=收起。每次 toggle 写 `v?'1':'0'`。
- `AN_LS_READ = 'loom-annotes-read'`：已读 note id 的 JSON 数组，**首渲染默认收起 / 空 Set，localStorage 读取放进 `useEffect` 里延迟到 mount 后再 hydrate**（try/catch → 空 Set）。`isUnread(n) = isFresh(n.created_at, now) && !readSet.has(n.id)`。`markAllRead(notes)` 并入全部 id 并持久化 `JSON.stringify([...set])`。
- **SSR hydration-mismatch guard（critic round-1 advisory 修复）**：`today/page.tsx` 是 `'use client'`（main 核对 L1），但 Next App Router 仍会 SSR 首帧。若 hook 在首渲染就同步读 `localStorage`，SSR（无 window）与 client 首帧不一致会触发 hydration mismatch 报错。**对齐仓库先例 `app/(app)/review/page.tsx`（L48/L61/L69：`typeof window === 'undefined'` guard + read-on-mount）**：open 默认 `false`、read Set 默认 `new Set()`，两者都在 `useEffect`（mount 后）才从 localStorage 读真值并 `setState`，server 与 client 首帧因此一致。collapse/read 视觉在 hydrate 完成后才反映持久态（可接受的一帧闪动，旁观块非首要内容）。
- **纯本地、零后端写**（只读铁律）。两视图共用同一 hook、同一 key，读态在两处一致（hook 在各自 mount-effect 读同一 localStorage key）。

---

## 6. CSS 落位（append `app/globals.css`，统一 wrapper scope）

全部 `.an-*` 净新（main 核对：clean main globals.css 当前 0 个 `.an-` 类）。所需 token 全部已存在（**main 核对**，行号对 clean main a9a12faf：`--paper-sunk` L132、`--paper-raised` L133、`--ink-4` L139、`--ink-5` L140、`--line-strong` L143、`--coral`/`-soft`/`-line`/`-ink` L146-151、`--hard*` L158-161、`--good*` L163-166、`--info*` + `--info-line` L168-170/253、`--r-pill` L223、`--ls-wide` L204、`--dur-base` L235、`--ease-out` L114/231；`.badge .dot.pulse` keyframe `loom-pulse-dot` L5813-5816）。

**作用域策略（关键，解 §0.2 tone-chip 只 scope 在 `.today-loom` 的问题）：**
- 紧凑块在 Today 页 mount，外层已有 `.today-loom`；全屏页用 **net-new wrapper `.agentnotes-loom`**（仿 `.events-loom`/`.knowledge-loom` 模式）。
- 把所有 `.an-*` 规则同时 scope 在 `.today-loom` 与 `.agentnotes-loom` 下（`.today-loom .an-board, .agentnotes-loom .an-board { ... }`），或更简洁：给两视图根都加一个共享 hook class（如 `.an-scope`），所有 `.an-*` scope 在 `.an-scope` 下，Today 块外层 wrapper 加 `an-scope`，全屏页根 `className="page view agentnotes-loom an-scope"`。**倾向后者**（单作用域，避免双前缀重复）。
- **signal chip tone 着色不依赖 `.today-loom .tone-chip-*` 继承**：在 `.an-scope` 下重新声明 `.an-sig.tone-chip-{hard,info,good,coral,neutral}`（四色 soft/line/ink，§设计 §4 表），保证全屏页（不在 `.today-loom` 下）也正确着色（风险点 R1）。

**净新规则清单（对照设计 §1/§2/§3/§4）：**
- 板壳：`.an-board { background: var(--paper-sunk); box-shadow: none; border-style: dashed; }`（沉降+虚线 = 旁观视觉，覆盖默认 Card 的 raised/shadow/solid）。
- 头部：`.an-head` / `.an-head-toggle`（reset button）/ `.an-head .card-icon`（覆盖 bg 为 `--paper-raised` 让 icon chip 凸出沉降板）/ `.an-head-titles` / `.an-sub` / `.an-head-spacer` / `.an-open-full`（pill，hover coral-soft + 箭头 nudge）/ `.an-chev-btn` + `.an-chev`（`.an-board.is-open .an-chev{transform:rotate(180deg)}`）。
- feed/note：`.an-feed`（入场动画 `anFeedIn`，仅 `prefers-reduced-motion: no-preference`）/ `.an-note[data-unread]` / `.an-rail` + `.an-rail::before`（1px 连线 + first/last/only trim）/ `.an-avatar.tone-X`（30×30，四 tone 覆盖）/ unread dot `.an-avatar::after`（9×9 coral，`.an-board` 内 punch-out border 用 `--paper-sunk`、全屏卡用 `--paper-raised`）。
- main：`.an-route` / `.an-ag.an-from` / `.an-flow` / `.an-ag.an-to` + `.an-to-sep` / `.an-new`（coral pill）/ `.an-sig.tone-chip-X`（`margin-left:auto` 右贴）/ `.an-body` + `.an-body b` + `.an-code` / `.an-meta` + `.an-conf` + `.an-time` + `.an-evi`（info-ink，hover info-soft）+ `.an-expire`（hard 琥珀 badge）/ `.an-ttl`（plain）。
- 紧凑专属：`.an-peek`（虚线 top + 截断 `.an-peek-txt`）/ `.an-foot`（虚线 top，`.an-foot-link` coral）/ `.an-empty`（裸一行，无 card chrome）。
- 全屏专属：`.an-overview` / `.an-ov-top` / `.an-ov-stat` / `.an-ov-n.serif.tnum`（36px coral）/ `.an-ov-lab` / `.an-filterbar` / `.an-fchip`（hover line-strong；`.is-on` 反相暗 pill `--ink` bg / `--paper` text）/ `.an-fdot`（实色 `var(--X)`）。
- 响应式 `@media (max-width:560px)`：`.an-sig{margin-left:0}` / `.an-rail{width:26px}` / `.an-avatar{26×26}`。
- 动画：`@keyframes anFeedIn`（opacity+translateY-4px）；`.an-chev` transition；`.an-open-full:hover .ico` translateX；`.an-fchip` transition。

> CSS 落位放在 globals.css 文件末尾，前面用块注释标注来源（`/* ---- YUK-294 AgentNotes (.an-*) ---- */`），与既有 `.events-loom` / `.today-loom` 块风格一致。
>
> **⚠️ globals.css 是 YUK-288 并发写者（critic round-1 修复，见 §9 R0）**：in-flight 的 `yuk-288-question-bank-ui-s1` 也在 `app/globals.css` **文件尾**追加了一段 ~715 行 `.tool-use-card` COPILOT 块（main 之后 `8307,+715`）。YUK-294 的 `.an-*` 块同样追加文件尾——两条 lane 都写 EOF 区域，谁先落 main 另一条 rebase 必产生**纯文本 merge 冲突**。解决预期：两块作用域不相交（`.tool-use-card.*` vs `.an-*`），冲突是纯位置冲突，rebase 时把 `.an-*` 块**重新 append 到 YUK-288 块之后**即可，两块共存、无语义交叉。实现 lane 落地前先 `git diff --name-only main...yuk-288-question-bank-ui-s1 -- app/globals.css` 确认仍冲突，rebase 时按此处理。

---

## 7. 测试计划

### unit 分区（`vitest.unit.config.ts`，无 DB/无 R2/无 AI）

| 文件 | 用例 |
|---|---|
| `src/ui/agent-notes/meta.test.ts` | `signalMeta`/`agentMeta` 已知键命中正确 label+tone/icon；**未知键 fallback**（label=原始 kind、tone=neutral、icon=sparkle）；空字符串/异常 kind 不抛。 |
| `src/ui/agent-notes/derive.test.ts` | `isFresh`：23h59m→true、24h01m→false（注 now）。`deriveTtl`：无 expires_at→null、剩 47h→soon、剩 49h→非 soon、已过期边界。`dayGroupOf`：今天/昨天/更早三档按真本地日界（注 now，覆盖跨午夜）。`anInlineMd`：纯文本、`**bold**`、`` `code` ``、混合、未闭合标记不破坏。`resolveEvidence`：event ref→`/events/:id` href、非 event ref→无 href 仅展示、refs 空→兜底 caused_by_event_id、全空→空。 |

> 这些文件**不 import** `tests/helpers/db` / `@/db/client` / `postgres` / `drizzle` / `PgBoss`，确保留在 unit 分区（`pnpm audit:partition` 通过）。纯 React 组件（AgentNoteCard/Board）若不引 DB 也可 unit 测渲染，但优先把逻辑下沉到 meta/derive 纯函数，组件测可选（视实现 lane 时间，最低保证 meta+derive 全覆盖）。

### DB 分区（`vitest.db.config.ts`，testcontainer Postgres，`resetDb()` per `beforeEach`）

| 文件 | 用例 |
|---|---|
| `src/server/agents/notes.test.ts`（追加） | `readAllAgentNotes`：跨 target_agents 不过滤、过期仍过滤、newest-first、limit、`limit<=0→[]`（§3）。 |
| `app/api/agents/notes/route.test.ts`（新建） | GET 200 返回 `{ rows }`；limit 参数透传；非法 limit → 400 `validation_error`；空表 → `{ rows: [] }`。route 测试因 import 真实 `db`/`readAllAgentNotes`，落 DB 分区（不 mock DB）。 |

### 命令（实现 lane 在 worktree 内跑）

- UI/纯函数：`pnpm test:unit:watch src/ui/agent-notes/` + 触碰文件 Biome。
- 后端/route：`pnpm test:db:watch src/server/agents/notes.test.ts` 与 route 测试。
- PR 前 gate（必须，按 CLAUDE.md）：`pnpm typecheck` / `pnpm lint` / `pnpm audit:schema` / `pnpm audit:partition` / `pnpm audit:profile` / `pnpm test` / `pnpm build`。

---

## 8. commit 切分

**① 后端读变体 + API**（DB 层闭环，可独立绿）
- `src/server/agents/notes.ts`（`readAllAgentNotes` + `rowToAgentNote` 抽取）
- `src/server/agents/notes.test.ts`（新读变体 DB 测）
- `app/api/agents/notes/route.ts` + `route.test.ts`
- message: `feat(agents): add unfiltered agent-notes read variant + GET /api/agents/notes (Refs YUK-294)`

**② UI 组件 + 页面 + 样式 + Today 插入**（含末 commit 的 Closes）
- `src/ui/primitives/LoomIcon.tsx`（补 `chevronDown`）
- `src/ui/agent-notes/{meta,derive,useAgentReads}.ts` + `{meta,derive}.test.ts`
- `src/ui/agent-notes/{AgentNoteCard,AgentNotesBoard}.tsx`
- `app/(app)/agent-notes/page.tsx`
- `app/(app)/today/page.tsx`（mount + query）
- `app/globals.css`（`.an-*`）
- message: `feat(today): AgentNotes 看板（AI 观察）只读旁观块 + /agent-notes drill-in\n\nCloses YUK-294`

> 切分理由：① 是纯数据/后端，能独立通过 DB 测；② 依赖 ① 的 API。两 commit 都在**文首 BLOCKER 完成（分支已 reset 到 clean main a9a12faf）之后**现场实现——不得在被污染的 YUK-288 基线上提交。**末 commit 带 `Closes YUK-294`**（触发 Linear integration 自动 attach），并补 `Co-Authored-By` trailer。若实现 lane 走 PR 流程，PR 标题含 `YUK-294`，PR base 必须是 `main`（非 YUK-288 分支）。

---

## 9. 风险点与并发冲突面

- **R0（并发冲突面：YUK-288 同写 `app/globals.css`，BLOCKER 级，critic round-1 修复）**：本任务被显式要求评估 in-flight YUK-288 的冲突面。实证：
  - `git diff --name-only main...yuk-288-question-bank-ui-s1` 含 **`app/globals.css`**（且 `.tool-use-card` 块 ~954 行新增，文件尾 `8307,+715` 追加 COPILOT 块）。
  - 行数佐证：main = 10112、yuk-288 = 11066、（被污染的）yuk-294 worktree = 10879。
  - **唯一重叠文件是 `app/globals.css`**——两条 lane 都 append 到文件尾 EOF 区域 → 谁先落 main、另一条 rebase 时必产生纯文本冲突。
  - `src/ui/primitives/LoomIcon.tsx` 与 `app/(app)/today/page.tsx` **不在** YUK-288 改动清单内（已逐一核对 `git diff --name-only main...yuk-288` 列表，二者不在），故 YUK-294 对这两文件无冲突，只有 globals.css 需处理。
  - **冲突解决预期 / merge-order**：两块 CSS 作用域不相交（YUK-288 `.tool-use-card.*` 全 scope 在该 className；YUK-294 `.an-*` 全 scope 在 `.an-scope`），无任何选择器交叉、无 token 重定义。冲突是纯位置冲突。**不论谁先 merge**，后者 rebase 时把自己的 append 块原样挪到对方块之后即可，两块共存。实现 lane 在落地与 rebase 两个时点各跑一次 `git diff --name-only main...yuk-288-question-bank-ui-s1 -- app/globals.css` 确认状态。本 lane 不引入对 YUK-288 的代码依赖；YUK-294 仍是 stand-alone lane。
- **R1（CSS 作用域，已在 §6 定方案）**：`.tone-chip-*` 在 globals.css 只 scope 在 `.today-loom` 下，全屏页拿不到。→ 用统一 `.an-scope` wrapper + 在该 scope 下重新声明 `.an-sig.tone-chip-X` 四色，不依赖 `.today-loom` 继承。落地后必须**两个视图都视觉核对** signal chip 着色（playwright 截图）。
- **R2（unread dot punch-out 双 surface）**：unread dot 的 2px ring 颜色必须匹配背后表面——紧凑块沉降板用 `--paper-sunk`，全屏 raised 卡用 `--paper-raised`。设计 §4 明确，错了会有可见 halo。CSS 用 `.an-board .an-note[data-unread] .an-avatar::after { border-color: var(--paper-sunk) }` 覆盖，默认（全屏）`--paper-raised`。
- **R3（`created_at` 序列化）**：API JSON 把 `Date` 序列化成 string，前端要 `new Date()` 还原再喂 derive；derive 内对 string/Date 都容错（仿 `formatRelTime`）。漏转会让 day 分组/fresh 推导全错。
- **R4（open vocab fallback 漏渲染）**：未知 `signal_kind`/`source_task_kind`/未知 `kind` 的 ref 都必须有兜底渲染路径，不能 `undefined.label` 崩。filter bar 也要能列未知 signal。meta.test.ts 必须显式覆盖未知键。
- **R5（partition lint）**：route.test.ts 与 notes.test.ts 引真实 DB，必须在 DB 分区；meta/derive 测试不能引 DB，留 unit 分区。提交前跑 `pnpm audit:partition`。
- **R6（只读铁律回归）**：组件实现中**严禁**出现任何 accept/dismiss/undo/写后端的交互；唯一有状态交互是 localStorage read/open。review lane 专项核对无后端写。
- **R7（图标补键副作用）**：给 `LoomIcon.ICONS` 加 `chevronDown` 是全局表，确认不与既有键冲突（已确认无该键），path 风格与既有 feather 一致（stroke-only，viewBox 0 0 24 24）。
- **R8（dev 端口）**：worktree 本地起 `pnpm dev:local`（compose Postgres :5433 为真相源）；若 :3000 被既有容器占用会跳 :3001，视觉核对前先确认命中的是新 build（项目 memory 既有教训）。

---

## 10. Linear

YUK-294 为本 lane 的实施 issue，末 commit `Closes YUK-294`。无新增 actionable follow-up——若实现期发现真实 `signal_kind`/`source_task_kind` 词表需要与 YUK-293 对齐扩充 META，记为 YUK-294 内的实现细节或在 PR body 提一句，不另开 issue（plan 阶段只读，无代码改动产出）。
