# YUK-271 — block_merge proposal accept 兑现 + inbox 接受按钮启用

> 规划者只读产出。实施者按本计划落地。
> Worktree: `/Users/yukoval/yukoval-projects/the-learning-project/.claude/worktrees/yuk271-block-merge`
> Branch: `yuk-271-block-merge-accept`

---

## 0. TL;DR — 实际剩余 scope（关键修正）

SPEC 的「已知事实」对后端的描述**已过时**。勘察结论：

- **后端 accept 执行体已完整实现且已测**。`acceptBlockMergeProposal`（`src/server/proposals/actions.ts:1508-1597`）已经存在：复用 `mergeQuestions`（YUK-195 primitive），两步事务（merge 自带 tx → 写 rate event），idempotent guard，stale 软拒绝。dispatch 已接线（`actions.ts:620-621`）。`BlockMergeAcceptResult` 类型已导出（`actions.ts:172-180`）。
- **DB 测试已覆盖**。`src/server/proposals/actions.test.ts:1443-1690` 有完整的 `describe('block_merge proposal lifecycle')`，4 个用例：written / dedup（去重+strip primary）/ idempotent（含 signal 单行）/ stale（not_draft 软拒绝）。
- **accept route 已支持**。`app/api/proposals/[id]/accept/route.ts` 是 kind-agnostic 的，`block_merge` 已可经 `acceptAiProposal` 走通。
- **producer 已实现**。`src/server/proposals/producers.ts:327-375` 产出 `block_merge` proposal（target `question_block`，cooldown_key 含排序后的 merge ids）。

**因此 YUK-271 的真实剩余工作 = 前端 inbox**：

1. inbox 当前把 `block_merge` 落进 `GenericProposalCard`，其「接受」按钮**硬 disabled**（`app/(app)/inbox/page.tsx:529-538`，文案「待接入」/ title「YUK-44 接入 owner-service 后启用」）。需要为 `block_merge` 启用接受按钮。
2. inbox 的**本地类型漂移**：`ProposalKind` union（`inbox/page.tsx:22-34`）缺 `block_merge` / `goal_scope` / `image_candidate` / `defer`；`KIND_LABELS`（:124-137）同缺。结果是 `block_merge` 卡片标题渲染原始字符串 `block_merge` 而非中文标签，且 `kindTone` 落 `default`。
3. accept 返回的 `stale` / `idempotent` 结果当前前端**不处理**（accept mutation 只 `refreshInbox`）。stale 时 proposal 不变成 accepted（无 rate event），refresh 后该卡仍在 pending 列表里反复出现，用户无反馈。需最小处理。

红线复核：accept 仍是唯一执行触发点（不动）；零 schema migration（满足）；其他 kind 行为不变（`GenericProposalCard` 仍 disabled，只为 `block_merge` 开口）；UI 最小变化（复用既有 `Button` primitive + 既有 mutation）；mutation 可追溯（accept rate event 链完整），但 block_merge 的合并本身 **lossy 不可自动回退**（见 §7 FIX-2：retract 无 block_merge 反向分支，只留审计；producer rollback_plan 明示 no real unmerge）——红线满足的是「可追溯 + 前端不新增写路径」，**不是**「可回滚」。

---

## 1. 勘察答案（map 必答三题）

### ① `merge_questions` 工具 service 逻辑能否复用为 accept 执行体
**已复用，无需新建。** `acceptBlockMergeProposal` 直接调 `mergeQuestions(db, { actorRef:'proposal:accept', primaryBlockId, mergeBlockIds })`（`actions.ts:1552-1556`）。`mergeQuestions` 来自 `src/server/ingestion/block-structured-edit.ts`（YUK-195），自带 `db.transaction`，返回 discriminated status（`written` / `skipped:*`）。accept 用两步：先跑 merge（自带 tx），再写 rate event（`writeEvent(db, …)`），靠 `existingAcceptRate` 保证重试幂等。这是 design 2026-06-02 §4 锁定的形状，已落地。**实施者不要改后端。**

### ② block 已各自成题时合并 question 的影响面
此影响面**由 `mergeQuestions` primitive 自身承担**，不在 YUK-271 的 accept handler 内。block_merge 作用对象是 ingestion 期的 `question_block`（draft 态、`ingestion_session_id` 同会话），不是已发布 `question`。证据：
- `mergeQuestions` 要求 draft + same-session + structured（`actions.test.ts:1448-1450` 注释 + stale 用例 `not_draft`）。一旦 block 离开 draft（已 import 成题 / 已手动 merge），软拒绝 → accept 返回 `stale`，不动既有 attempt/FSRS/learning_item。
- 因此 attempt/FSRS/learning_item 引用归属、events 审计链、回滚语义都落在 block 尚未成题的窗口内，YUK-271 不引入新的跨题归属逻辑。回滚语义：accept 写的是一条 `rate`(accept) event（`subject_kind:'event'`, `caused_by_event_id:proposalId`），retract 走既有 `/retract` 通路（不在本 issue scope）——但**对 block_merge 该通路只写审计 event、不 un-merge**（见 §7 FIX-2），所以这里说的「回滚语义落在 draft 窗口内」指的是：合并只在 block 尚未成题时发生、因此不污染已发布题的引用链，**不是**指 merge 可被 retract 撤销。
- **实施者无需为合并归属写新代码**；只需在前端把 `stale` 结果反馈给用户（见 §3 task C）。

### ③ image_candidate seam 的接线模式（依葫芦画瓢）
image_candidate（YUK-227 S3 Slice C）确立的模式，block_merge 已对齐：
- **accept 唯一触发点**：`dispatchAccept` 的 `case` 内调用（`actions.ts:622-627` image_candidate / `:620-621` block_merge）。两者都 `ensureAcceptOnly`。
- **ledger 行防双计**：image_candidate 用 accept rate event + ledger；block_merge 用 `existingAcceptRate` 幂等 guard + 单条 accept rate event（`actions.test.ts` idempotent 用例断言 rate event 仅 1 行、signal 仅 1 行）。
- **前端启用模式**：这正是 YUK-271 要补的对称缺口 —— image_candidate 当前**也**落 `GenericProposalCard`（同样 disabled）。**本 issue 只为 `block_merge` 开按钮**（红线：其他 kind 行为不变）；image_candidate 的按钮启用是它自己的 follow-up（见 §6 Linear gate）。

---

## 2. 文件清单（创建 vs 修改）

| 文件 | 动作 | 说明 |
|---|---|---|
| `app/(app)/inbox/page.tsx` | 修改 | 核心：新建 `BlockMergeProposalCard` + 在卡片 dispatch 里为 `block_merge` 分流；补 `ProposalKind` union / `KIND_LABELS` / `kindTone` 的 `block_merge`；accept mutation 处理 `stale`。 |
| `app/(app)/inbox/inbox.test.tsx`（若不存在则**创建**） | 创建/修改 | 组件级单测（unit 分区）：`block_merge` 卡片接受按钮 enabled、点击触发 accept、stale 反馈。仅当组件可在无 DB 下渲染时归 unit；否则降级为后端已覆盖 + 手测（见 §4 决策）。 |
| `src/server/proposals/actions.ts` | **不改** | 后端已完成。 |
| `src/server/proposals/actions.test.ts` | **不改** | 后端测试已覆盖 4 例。 |
| `src/core/schema/proposal.ts` | **不改** | schema 已有 `block_merge` + `BlockMergeProposalChange`。 |
| `app/api/proposals/[id]/accept/route.ts` | **不改** | kind-agnostic，已支持。 |

UI design pre-flight（CLAUDE.md 要求）——本改动触及 UI，实施者动手前须：
- **组件类型声明**：`block_merge` 走**新 card 组件**（route 内联组件，非 drawer/modal/page），与既有 `EdgeProposalCard` / `NodeProposalCard` 同构。
- **逐字引用 design doc**：design 2026-06-02 §6 UI 把「primary + merge-block preview / confidence / continuity_signal badge」标为**deferred UI redraw slice**（见 `app/(app)/today/page.tsx:722-724` 注释逐字佐证）。**故本 issue 的卡片是最小启用版**：复用 `GenericProposalCard` 的 JSON 预览布局，仅把「接受」按钮启用并接 `acceptMutation`，**不实现** confidence 排序 / continuity badge / merge-block 富预览（那是 YUK-169 redraw slice）。实施者须在 PR 描述里声明这一点并**等用户 approve UI pre-flight 后再写卡片 JSX**。

---

## 3. 实施步骤（commit 切分）

### Commit 1 — fix(inbox): 补 block_merge 到本地 ProposalKind 类型 + 标签（消除字符串漂移）

`app/(app)/inbox/page.tsx`：

- **C1.1** `ProposalKind` union（:22-34）补 `'block_merge'`。为消除整体漂移，同时补 `'goal_scope'` / `'image_candidate'` / `'defer'`（与 `src/core/schema/proposal.ts` 的 `aiProposalKinds` 对齐；这些 kind 已能进 inbox 列表，缺标签会渲染原始串）。
- **C1.2** `KIND_LABELS`（:124-137）为新增 kind 补中文标签：
  - `block_merge: '题块合并'`
  - `goal_scope: '目标范围'`
  - `image_candidate: '图片来源'`
  - `defer: '延后'`
  （`kindLabel` 已有 `?? kind` 兜底，但显式标签是本 commit 的目的。）
- **C1.3** `kindTone`（:657-676）：`block_merge` 归 `'info'`（review 类，呼应 today/page 的 `'review'` bucket）；其余新增 kind 落既有 `default → 'neutral'` 即可，不必逐一列。

> 此 commit 纯类型 + 文案，无行为变化，可独立 review。

### Commit 2 — feat(inbox): 启用 block_merge 接受按钮（YUK-271 核心）

`app/(app)/inbox/page.tsx`：

- **C2.1** 新增类型守卫 `isBlockMergeProposal(row): row is ProposalInboxRow & { payload: BlockMergeProposalPayload }`，判定 `row.kind === 'block_merge'`。同时新增本地 `BlockMergeProposalPayload extends BaseProposalPayload`，`proposed_change` 形为 `{ primary_block_id: string; merge_block_ids: string[]; ingestion_session_id: string; continuity_signal?: string; confidence?: number }`（镜像 `src/core/schema/proposal.ts:144-156`，**只读展示用**）。
- **C2.2** 新增 `BlockMergeProposalCard`（参照 `GenericProposalCard` 结构，§2 pre-flight 已声明为最小版）：
  - head：`<Badge tone="info">{kindLabel('block_merge')}</Badge>` + `targetLabel` + `proposalMeta`。
  - body：`reason_md`（连续性说明）。
  - summary：复用 `proposal-summary` / `proposal-json` 既有 class 展示 `proposed_change`（primary + merge ids），保持最小、不引新 CSS。
  - actions：
    - **接受**按钮 `variant="good" icon="check" disabled={pending}` `onClick={onAccept}`（**与 NodeProposalCard 同构**，文案「接受」）。**这是 issue 的核心改动**：把 disabled「待接入」换成可用「接受」。
    - **忽略** `variant="ghost" icon="x"` → `onDismiss`。
    - **撤回** `variant="danger" icon="trash"` → `onRetract`。
    - 事件链 `Link`。
- **C2.3** 卡片 dispatch（:282-320）在 `isKnowledgeNodeProposal` 分支后、`return <GenericProposalCard/>` 前插入：
  ```
  if (isBlockMergeProposal(row)) {
    return (
      <BlockMergeProposalCard
        key={row.id}
        proposal={row}
        pending={mutating}
        onAccept={() => acceptMutation.mutate({ id: row.id })}
        onDismiss={() => dismissMutation.mutate({ id: row.id })}
        onRetract={() => retractMutation.mutate({ id: row.id })}
      />
    );
  }
  ```
  `acceptMutation` 已存在（:163-181），无 decision/relation 入参即走纯 accept（后端 `ensureAcceptOnly` 接受 undefined decision）。**不新增 mutation。**
- **C2.4** InboxSection 的 `note`（:272）「当前 node / edge 可直接接受」更新为「当前 node / edge / 题块合并 可直接接受」。

### Commit 3 — feat(inbox): block_merge accept 的 stale / idempotent 结果反馈

后端 accept 对 block_merge 可返回 `{ stale: true, skip_reason }`（未写 rate event，proposal 仍 pending）或 `{ idempotent: true }`。当前 `acceptMutation.onSuccess` 仅 `refreshInbox`，stale 时卡片刷新后仍在列表，用户无反馈。

`app/(app)/inbox/page.tsx`：

- **C3.1** 给 `acceptMutation` 加 `onSuccess: (data) => { … }`：若 `data?.kind === 'block_merge' && data.stale`，用既有轻量通道提示「该合并提议已失效（题块状态已变更：${skip_reason}），已跳过」。**最小实现**：复用 inbox 现有的错误/状态展示位（若无 toast primitive，则用一个局部 `useState<string|null>` 的 inline notice，渲染在 `inbox-meta-line` 下方，class 复用既有 `inbox-empty` / `meta`，不引新样式）。`refreshInbox` 仍调用（把已 accepted 的移出 pending；stale 的留在列表但带 notice）。
- **C3.2** `idempotent` 静默成功即可（refresh 后卡片消失），无需额外 UI。

> C3 是 UX 收尾，可与 C2 合并为一个 commit 以减少切分（实施者酌情：若 C2 review 后 stale 反馈被认为非必需，C3 可降级为 Linear follow-up，见 §6）。

### Commit message 模板（每个 commit 末尾）

```
<type>(inbox): <subject>

<body：引用 design 2026-06-02 §4/§6，说明最小启用 vs deferred redraw slice>

Refs YUK-271

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

最后一个 commit（或 PR-closing commit）用 `Closes YUK-271`：

```
feat(inbox): enable block_merge accept button + stale feedback

block_merge 后端 accept 执行体（mergeQuestions 复用）此前已完成并测覆盖；
本变更补上前端缺口：inbox 为 block_merge 启用接受按钮、修正本地
ProposalKind 类型漂移、处理 accept 的 stale 结果反馈。最小启用版，
confidence 排序 / continuity badge / merge-block 富预览仍属 YUK-169
redraw slice（design 2026-06-02 §6 deferred）。

Closes YUK-271

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

> 单 commit 完成亦可（C1+C2+C3 合一），则该 commit 直接用 `Closes YUK-271`。Linear 自动 attach 靠 commit message 的 `Closes`（非 PR body）——务必写在 commit 里。

---

## 4. 测试清单（含分区归属）

后端**已覆盖**（不重复写）：`src/server/proposals/actions.test.ts:1443-1690`（DB 分区，`vitest.db.config.ts`）——written / dedup / idempotent / stale 四例。实施者**跑一遍确认绿**即可：
```
pnpm vitest run --config vitest.db.config.ts src/server/proposals/actions.test.ts -t 'block_merge proposal lifecycle'
```

前端新增（按可测性二选一，实施者落地时定）：

- **首选 · unit 分区**（`vitest.unit.config.ts`）：`app/(app)/inbox/inbox.test.tsx`（新建）。前提：inbox `page.tsx` 是 `'use client'` + 依赖 `@tanstack/react-query` + `useSearchParams`，组件级渲染需 mock `apiJson` / QueryClient / `next/navigation`，**不触 DB / R2 / AI**，故归 unit。用例：
  1. 给定一行 `block_merge` proposal，`BlockMergeProposalCard` 渲染，接受按钮 **enabled**（断言 `disabled` 不存在 / 文案「接受」非「待接入」）。
  2. 点击接受 → `apiJson` 被以 `POST /api/proposals/<id>/accept` 调用。
  3. accept 返回 `{ kind:'block_merge', stale:true, skip_reason:'skipped:not_draft' }` → 渲染 stale notice（C3 落地时）。
  4. `kindLabel('block_merge')` 渲染「题块合并」非原始串（覆盖 C1）。
  > **【critic FIX-1：partition include 是 P0，原计划会让测试静默不跑】** 校验过 `vitest.shared.ts`：`fastTestInclude`（unit）和 `allTestInclude`（db）的 glob **几乎全是 `.test.ts`**；唯一的 `.test.tsx` 入口是 `'src/ui/**/*.test.tsx'`（`vitest.shared.ts:212`）。一个放在 `app/(app)/inbox/inbox.test.tsx` 的文件 **既不被 `app/**/*.test.ts` 命中（扩展名不符）也不被 `src/ui/**/*.test.tsx` 命中（目录不符）** → 它落进 **NEITHER unit NOR db 分区**，`pnpm test` 永不执行它，§5 的 `pnpm vitest run --config vitest.unit.config.ts "…inbox.test.tsx"` 因 include 交集为空 → **0 test 跑、绿色退出、假覆盖**。实施者必须二选一落地：
  > - **(A) 推荐**：在 `vitest.shared.ts` 的 `fastTestInclude` 显式新增一行 `'app/(app)/inbox/inbox.test.tsx'`（仿照既有 per-file 入口，并补**mock 边界注释**说明它 mock `@/ui/lib/api`（`apiJson` 的真实出处，已核 `page.tsx:3`）/ `next/navigation` 不触 DB——每个 fastTestInclude 入口都有这种注释，见 `:23-26`）。**这是必须步骤，不是可选**。
  > - **(B) 替代**：把被测组件抽到 `src/ui/`（如 `src/ui/components/BlockMergeProposalCard.tsx`），测试随之放 `src/ui/components/BlockMergeProposalCard.test.tsx`，自动被 `'src/ui/**/*.test.tsx'` glob 命中。但这是更大的重构（要把卡片从 route 内联组件提到共享层），需重新过 UI pre-flight；不在最小启用版意图内，**不推荐**。
  > **`audit:partition` 盲区警告**：`scripts/audit-test-partition.ts` 的 walker 只收集 `*.test.ts`（`endsWith('.test.ts')`，walkTests 行），**完全看不见 `.test.tsx`**。所以原计划「`pnpm audit:partition` 必须通过」对一个 `.test.tsx` **给的是假保证**——audit 既不会校验也不会 flag 它。实施者落地 (A) 后须**本地手动确认**该测试真的在 `pnpm vitest run --config vitest.unit.config.ts` 下被收集并执行（看到用例数 > 0），不能只看绿色退出。该测试仍不得 import `tests/helpers/db` / `@/db/client` / `postgres` / `drizzle` / live `PgBoss`；mock 边界须在 import route/page 之前。
- **退路 · 若组件无法在 unit 环境干净渲染**（如 page 直接顶层 import 了 DB-touching 模块）：放弃组件单测，前端正确性靠 §5 手动视觉验证 + 后端已覆盖。**此时在计划/PR 里显式记录「前端无自动化测试，理由 = 组件渲染依赖不可在 unit 分区 mock」**，不要把测试硬塞进 db 分区凑数。

> 实施者落地前先判定：`grep` inbox `page.tsx` 顶层 import 是否含 DB/server-only 模块（当前勘察看到的 import 仅 `@/ui/*` / `@tanstack/react-query` / `next/*`，**倾向 unit 可行**）。

---

## 5. 验证（实施者按序跑）

```
# 触碰文件 Biome
pnpm biome check app/(app)/inbox/page.tsx

# 类型
pnpm typecheck

# 前端单测（若建了 inbox.test.tsx）
pnpm vitest run --config vitest.unit.config.ts "app/(app)/inbox/inbox.test.tsx"

# 后端回归（确认未误伤）
pnpm vitest run --config vitest.db.config.ts src/server/proposals/actions.test.ts -t 'block_merge proposal lifecycle'

# 分区 lint
pnpm audit:partition

# PR 前全 gate
pnpm lint && pnpm typecheck && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test && pnpm build
```

视觉验证（CLAUDE.md UI 视觉环）——需要一条 `block_merge` pending proposal：
1. `pnpm dev:local`（注意：OrbStack 容器长期占 :3000，dev 会跳 :3001；以 dev 进程实际打印端口为准，勿 curl :3000 拿旧 build）。
2. 经 producer 或 seed 造一条 `block_merge` proposal（producer 在 `src/server/proposals/producers.ts:327`；或用 `actions.test.ts` 的 `seedBlockMergeProposal` 形状手动 insert）。
3. 访问 `/inbox`：确认 `block_merge` 卡片标题为「题块合并」、**接受按钮 enabled**、点击后卡片从 pending 移除（或 stale 时显示 notice）。playwright 截图 + visual-verdict 对照（最小启用版，无需对照 redraw 稿）。

---

## 6. Linear issue capture gate

- **YUK-271**：本计划即其实现；最后 commit `Closes YUK-271`。
- **发现的对称 follow-up（需建/确认 Linear issue，实施者在收尾时执行 capture gate）**：
  1. **image_candidate inbox 接受按钮启用** —— 与 block_merge 完全对称，image_candidate 当前也落 disabled `GenericProposalCard`。YUK-227 S3 Slice C 只做了后端 accept seam，前端按钮未启用。建议确认是否已有 issue（搜 YUK-227 子项 / 「image_candidate inbox」），无则新建。**不在 YUK-271 scope**（红线：其他 kind 行为不变）。
  2. **goal_scope inbox 接受按钮启用** —— 同样后端有 `acceptGoalScopeProposal`（YUK-143/ADR-0024）但前端 disabled。确认 YUK-143 是否已含 UI 子项；无则建。
  3. **block_merge redraw slice（YUK-169）** —— confidence 排序 / continuity_signal badge / merge-block 富预览，design 2026-06-02 §6 deferred。确认 YUK-169 已存在（today/page 注释引用了它），无需新建，仅在 PR 里 link。
- 若以上 1/2 已有覆盖 issue，则在 PR 描述里 link 并说明「YUK-271 仅 block_merge，对称项见 YUK-XXX」即可，无需重复建。

---

## 7. 回退方案

- **全量回退**：纯前端 + 类型改动，单文件（`inbox/page.tsx`）+ 可选 1 个新测试文件。`git revert <commit>` 即可，无 schema migration、无数据迁移、不触后端写路径，零残留。
- **运行时回退**：即使前端 accept 误触，后端 `acceptBlockMergeProposal` 自带 `existingAcceptRate` 幂等 + `stale` 软拒绝，错误 accept 不会双 merge。
  > **【critic FIX-2：原文「撤回可回退已 accept 的 merge」是错的，会误导实施者 + PR 描述 + 用户】** 核过 `retractAiProposal`（`src/server/proposals/actions.ts:1920-2009`）：它对 `variant_question` / `learning_item` / `goal_scope` / record 各有反向 tombstone 分支，但 **没有 `block_merge` 分支**。对 block_merge，retract **只写一条 `correct`(retract) audit event**——它**不 un-merge structured 树、不把 `ignored` 的 merge 块翻回 `draft`、不还原 `merged_from_block_ids`**。merge 本身是 lossy / 不可逆的，producer 自己的 `rollback_plan.action` 写明：「accept reuses mergeQuestions, which is lossy — no real unmerge, §7」（`src/server/proposals/producers.ts`）。正确表述：**accept 后的 merge 可追溯（event 链完整）但不可自动回退**；撤回按钮对 block_merge 只留审计痕迹，不恢复合并前的块结构。真要恢复需在 draft 期前手动重建块（超出本 issue scope）。**实施者不得在 PR 描述里宣称「撤回可回退合并」**。这也意味着 §3 C2.2 给 block_merge 卡片挂的「撤回」按钮语义 = 仅记录撤回意图（与其它 kind 的撤回按钮一致的最小行为），不等于 unmerge——实施者按此理解接线即可，无需新增后端。
- **stale 反馈（C3）单独回退**：若 stale notice 体验不佳，可只 revert C3 commit，保留 C1+C2 的按钮启用（accept 仍工作，只是 stale 时无显式提示、卡片留在列表——回到 refresh-only 行为）。

---

## 附：关键证据锚点（实施者核对用）

- 后端 accept 已实现：`src/server/proposals/actions.ts:1508-1597`（`acceptBlockMergeProposal`），dispatch `:620-621`，类型 `:172-180`。
- 后端测试：`src/server/proposals/actions.test.ts:1443-1690`。
- inbox disabled 按钮（要改的点）：`app/(app)/inbox/page.tsx:529-538`（GenericProposalCard）。
- 卡片 dispatch 插入点：`app/(app)/inbox/page.tsx:282-320`。
- 本地类型漂移：`app/(app)/inbox/page.tsx:22-34`（union）/ `:124-137`（labels）/ `:657-676`（tone）。
- accept mutation（复用）：`app/(app)/inbox/page.tsx:163-181`。
- schema（不改，镜像用）：`src/core/schema/proposal.ts:144-156`。
- accept route（kind-agnostic）：`app/api/proposals/[id]/accept/route.ts`。
- Button 可用 variant：`src/ui/primitives/Button.tsx:6-15`（含 `good`/`ghost`/`danger`/`info`）。
- mergeQuestions 复用来源：`src/server/ingestion/block-structured-edit.ts`（YUK-195，自带 tx，discriminated status）。
