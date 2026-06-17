# Phase 1 增量 3 — matcher 仲裁器核心 + caller-agnostic verify gate（薄派发）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`。**TDD**：每个 Task 先红测后绿实现。
>
> **Spec:** `docs/superpowers/specs/2026-06-17-matcher-form-spec.md`（§3 核心形态、§3.1.5 Demand、§3.2 仲裁流程、§3.3 gate、§4 复合阈值、§6 重构面、§7 不变量、§8 inc 切分）。本计划落实一个**gate 设计决策**（owner 拍板，见下「Gate 设计决策」），同步更新 spec §3.3 措辞。
>
> **依赖（硬）**：inc-1 `poolFetch`（#447，**已 merge 到 `origin/main`**）+ inc-2 `queryExistingPool` 迁 `poolFetch`（**也已 merge 到 `origin/main`**，YUK-398 inc-2，见 `sourcing-sequence.ts:113-145` 头注释；spec §8 表把它标「待办」是陈旧的，origin/main 已落地）。本地 working tree 是落后的 main，`src/server/quiz/pool-fetch.ts` 不存在——**所有引用以 `origin/main` 为准**（用 `git show origin/main:<path>` 读权威版本）。
>
> **起点**：从 `origin/main`（含 #447 inc-1 + inc-2 `poolFetch` consumer 迁移）新建 worktree + 分支。本增量预计**无迁移**（纯查询 + 既有 verify 函数整体复用，不动 schema；唯一 schema-touch 风险是 Task 5 扩 `PoolRow` projection——那是 select 投影，非 DDL）；若实现期 `pnpm db:generate` 产 diff 即停下复核。
>
> **Linear**：YUK-396（matcher Phase 1，inc-3 = 本计划）。关联约束：YUK-386（两轴正交，决定 kind 兼容垫片何时删）、YUK-395（answer_class 新鲜度，gate answer_class 硬过滤开启）、YUK-361（选题/校准/供给主线，drive 来源）。

**Goal:** 落地一个 caller-agnostic 的 `matcher(demand)` 仲裁器：`poolFetch(activeOnly:false)` 召回 active+draft → 复合保守排序（KC+难度硬过滤 + cosine 软排序+阈值 + tier 排序）→ 逐候选 branch on `draft_status`（active 直接 USE / draft 经 gate 同步验证-promote 后 USE）→ 池中无可用则残余路由生成。gate **不合并、不重写**两个现有 verify handler——它是一个**薄 tier-dispatcher**，按 source-tier 选 source vs quiz，直接**整体调用**现有 `runSourceVerify` / `runQuizVerify`（二者在 origin/main 已是 per-question 可调的同步函数）。

---

## Gate 设计决策（owner 拍板，本计划核心）

**原计划想把 `runSourceVerify` + `runQuizVerify` 的 promote 块合并抽取成新 `verifyAndPromote`。这条被否决。** 理由（critic 用 `git show origin/main` 逐行证实）：

- `runQuizVerify` 远比 `runSourceVerify` 复杂，promote 路径**无法干净切割**：
  - **三态而非两态**：quiz_verify 产 `verified | needs_review | failed`（`verificationStatus`，`quiz_verify.ts:388-392`），source_verify 只有 `verified | failed`。
  - **`writeAgentNote` pool-gap 副作用**：quiz_verify 在 `!promote` 时 fire-and-log 一条 coach note（`quiz_verify.ts:540-573`），source_verify 没有。
  - **catch-bottom 写 metadata**：quiz_verify 的 catch 把 `verification.status='failed'` 写回 `metadata.quiz_gen`（`quiz_verify.ts:580-597`），source_verify catch 只写 error event。
  - **check 段与 promote+metadata 深度交织**：quiz_verify 的 promote 决策（`promote = parsed.overall==='pass' && checksPass && !isTooClose && materialGroundingOk && kindConformanceOk`）+ `copy_safety`/`verification` metadata 构造发生在同一 try 块里，与 promote txn 同生共死，提取它等于重写整个 handler。

**改为：gate = 薄派发，复用现有 verify 逻辑整体，不合并不重写。**

**关键 grounding（决定 b1 vs b2 的事实）——`git show origin/main` 证实两个 run 函数都是 per-question 可同步调用的**：

```ts
// source_verify.ts:96-100（origin/main）
export interface RunSourceVerifyParams { db: Db; questionId: string; runTaskFn: RunTaskFn; }
export async function runSourceVerify(params): Promise<RunSourceVerifyResult>;
// → 内部：re-SELECT row by questionId → guard source==='web_sourced' → 幂等查 verify event
//   → 跑 tier-2 checks → Option B gate → txn{ promote draft→active + FSRS enroll-if-absent
//   + writeEvent } → return { status, checks }

// quiz_verify.ts:176-196（origin/main）
export interface RunQuizVerifyParams { db: Db; questionId: string; runTaskFn: RunTaskFn; }
export async function runQuizVerify(params): Promise<RunQuizVerifyResult>;
// → 内部：re-SELECT row by questionId → guard source==='quiz_gen' → 幂等查 verify event
//   → 解 metadata.quiz_gen → 跑 QuizVerifyTask → Option B gate → txn{ promote + metadata 写回
//   + FSRS + writeEvent } → writeAgentNote(非 promote) → return { status, overall, copy_safety_verdict }
```

→ **选 (b1) — matcher / owner-path 直接 inline 调现有 run 函数。** 整函数被调用，所以三态 / `writeAgentNote` note / metadata 写回 / catch / 幂等 / 非-draft 守门**全部天然保留**，blast radius 归零（**不改任何 handler 文件**）。仲裁同步、spec §3.2 faithful（命中 draft 当场验、当场决定 USE）。**(b2) enqueue 路径不需要**——run 函数同步可调，无需退化成异步 stocking 语义。

**薄 dispatcher 的角色**：新建一个**薄** `verifyAndPromote` 模块——它**只按 source-tier 转调** `runSourceVerify` / `runQuizVerify`，**不重实现任何 verify / promote / metadata / note 逻辑**。它存在的唯一价值是给三个 caller（matcher lazy / owner manual override / 未来 pre-warm）一个**统一入口** + 一个**新增的 override(`skipVerify`) 路径**（owner 强制启用，inc-4 UI 用，inc-3 只实现函数 + 测它）。

> **spec §3.3 措辞同步**：spec §3.3 写「gate ≡ `verifyAndPromote(question)`……**复用现有 `quiz_verify`/`source_verify` per-source handler**」。这与本决策**一致**（dispatch 到现有 verify，非合并抽取）。实现 Task 1 时**逐字核对** spec §3.3 是否有「合并」「抽取」字样；本计划起草时 spec §3.3 line 99 措辞为「复用」，无冲突。若实现期发现 spec 任何处暗示「把两 handler 的 promote 块合并进 verifyAndPromote」，改成「verifyAndPromote 按 tier 转调现有 per-question verify 函数，不合并 promote 块」（一行 doc 改，附 commit 说明）。

---

## 落点裁定（§1）

- **matcher = 新模块** `src/server/quiz/matcher.ts`，**不改造 `runSourcingSequence`**（判别轴根本不同：后者 Step 1 写死 `activeOnly:true`、结构上看不到 draft，且是「enqueue-then-forget」语义；matcher 要 `activeOnly:false` 召回 active+draft 当场仲裁。两者语义对立，改造死代码徒增风险）。
- **`verifyAndPromote` = 新模块** `src/server/quiz/verify-and-promote.ts`，**薄 tier-dispatcher**：`deriveSourceTier` → tier ∈ {1,2} 走 `runSourceVerify`、tier ∈ {3,4} 走 `runQuizVerify`（按 source 字面更稳：`source==='web_sourced'` → source_verify，`source==='quiz_gen'` → quiz_verify；见 Task 4 dispatch 设计）+ 一个 `skipVerify` override 分支（owner 强制启用，写 verify event `actor_kind:'user'`+`skipped_verify:true`，**不调 AI**）。**它不含任何 promote 事务 / metadata 写回 / FSRS / note 逻辑**——那些全在被转调的 run 函数里。
- **现有 `runSourceVerify`/`runQuizVerify` 一行不改**。它们已是 per-question 同步函数；`verifyAndPromote` import 并整体调用之。
- **残余生成 = 复用 LIVE 链**，不新写 enqueue：matcher 残余分支把 demand 翻成 `QuestionSupplyTarget`，交 `dispatchSupplyTarget`（`dispatcher.ts:208`，已 export，带 cooldown + Tavily 闸 + `chooseAutoRoute` 硬偏好边界）。**不**裸调 `chooseAutoRoute`（私有未 export）。spec §3.2「复用 chooseAutoRoute」实指复用整条派发链。

**Tech Stack（import 路径已对 origin/main 核实）:**
- `src/server/quiz/pool-fetch.ts`（`poolFetch`/`PoolRow`，origin/main）
- `src/subjects/question-kind.ts`（`kindsMatch`，**是 `.ts` 文件不是目录**，line 86 export）
- `src/core/schema/provenance.ts`（`deriveSourceTier` line 129 / `compareBySourceTierThenWhitelist` line 188）
- `src/server/boss/handlers/source_verify.ts`（`runSourceVerify` / `RunSourceVerifyParams` / `RunTaskFn`，整体调用）
- `src/server/boss/handlers/quiz_verify.ts`（`runQuizVerify` / `RunQuizVerifyParams` / `RunTaskFn`，整体调用）
- `src/server/quiz/verify-framework.ts`（`checksForTier`——**仅 dispatcher 选 tier 时参考，不直接跑 check**；check 已在 run 函数内部跑）
- `src/server/question-supply/dispatcher.ts`（`dispatchSupplyTarget` line 208 / `DispatchResult` / `DispatchDeps`）
- `src/server/question-supply/target-discovery.ts`（`QuestionSupplyTarget` line 58 / `SupplyRoute` / `DifficultyBand` / `SupplyGapKind` / `targetFingerprint` line 237 / `seedRoutePreference` line 476 / `difficultyBandFor` line 199——**全部已 export，直接 import，绝不复刻**）
- `src/server/quiz/sourcing-sequence.ts`（`SourcingNeed` line 355 / `SourcingSequenceStep` line 48 / `ExistingPoolHit` line 60，跨模块复用，别重定义）
- `src/capabilities/knowledge/server/domain.ts`（`getEffectiveDomain` line 20——matcher 从 knowledgeId resolve domain）
- `src/subjects/profile.ts`（`resolveSubjectProfile` line 169 → `.id` 取 subjectId）
- `src/server/ai/embed.ts`（`embedText`/`embedMany`，DashScope text-embedding-v4@1024）
- **FSRS / event import（修正虚构路径）**：`@/server/fsrs/state`（`getFsrsState`/`upsertFsrsState`，**不是** `@/server/review/fsrs`）、`@/capabilities/practice/server/fsrs`（`initialFsrsState`）、`@/server/events/queries`（`writeEvent`，**不是** `@/server/ai/log.ts`——后者只 export `writeToolCallLog`/`writeCostLedger` 等，无 `writeEvent`）。**这些在 inc-3 不直接调**（promote/FSRS/event 全在被转调的 run 函数里）；列在此处是为了 Task 4 dispatcher 的 override 分支需要写 verify event（用 `writeEvent` from `@/server/events/queries`），以及守卫表的路径正确。
- Vitest db config（testcontainer）。

---

## 不在本增量（明确缓做）

- **answer_class 硬过滤**——gated on **YUK-395**（answer_class 新鲜度 on-write/re-derive 未解，读到 NULL/陈旧类）。`poolFetch` 头注释已显式把 answer_class 过滤 gate 在 YUK-395 之后。matcher v1 用 **KC + 难度 + kind 垫片 + cosine** 跑通；`Demand.answerClass` 字段**先收不用**（留接口、加 `// gated YUK-395` 注释，不进 WHERE）。
- **owner manual gate path UI/route**（审核并启用 + override 留痕的 UI）——spec §8 **inc-4**，本增量只把 `verifyAndPromote` 抽成 caller-agnostic dispatcher（含 `skipVerify` override 函数路径，为 inc-4 第三 caller 铺路），不做 UI/route。
- **forager + 廉价预筛**——spec §8 inc-5，Phase 1 后段；matcher 核心不依赖它（§2）。
- **pre-warm job**——spec §3.3 可选优化；现有 eager `source_verify`/`quiz_verify` 链保留为 pre-warm，**v1 不强拆、不改**。
- **跨 KC / domain 池**——v1 单 KC（与 `poolFetch` 一致，spec §9 开放问题 2）。
- **接线 matcher 进 LIVE 消费侧**（出卷/求卷 route/job）——`runSourcingSequence` / `SourcingSequenceResult.existing` 当前**无生产 caller**；matcher 接进消费侧是后续增量，inc-3 只产出可独立测的算子 + gate。
- **改两个 verify handler**——**不改**。(b1) 决策下两 handler 一行不动；spec §3.3「v1 不强拆」自然满足。

---

## File Structure

- **Create** `src/server/quiz/verify-and-promote.ts` — `verifyAndPromote(params)` 薄 tier-dispatcher（转调现有 run 函数 + override 分支）+ 返回类型。**不含 promote/FSRS/metadata/note 实现。**
- **Create** `src/server/quiz/verify-and-promote.db.test.ts` — dispatch-to-source / dispatch-to-quiz / override 留痕 / 非-draft 守门（经转调函数天然产生）/ 幂等（经转调函数）。
- **Create** `src/server/quiz/matcher.ts` — `matcher(db, demand, deps)` + `Demand` / `MatcherResult` / `MatchedQuestion` 类型 + `demandToSupplyTarget` 适配器。
- **Create** `src/server/quiz/matcher.db.test.ts` — active 命中、cosine 排序、queryText 路 B、NULL 降级、cosine 超阈→残余、残余生成、draft 命中-promote、draft fail-跳过、耗尽-残余。
- **Modify** `src/server/quiz/pool-fetch.ts`（**仅 Task 5**） — `PoolRow` additive 扩 `draft_status` + `cosine_distance` 两个 projection（不动 WHERE/ORDER；inc-1/2 caller 不受影响）。
- **不改** `source_verify.ts` / `quiz_verify.ts`（(b1) 决策）。

---

## 关键文件:行索引（origin/main，落地参照）

| 关注点 | 文件:行 |
|---|---|
| `poolFetch` / `PoolRow`（projection: id/difficulty/source/kind/metadata；**无 draft_status/distance/embedding**） | `src/server/quiz/pool-fetch.ts`（INCREMENT-2 MIGRATION CONTRACT 头注释 = A2 防线权威）|
| `runSourceVerify`（per-question，整体调用） | `src/server/boss/handlers/source_verify.ts:96`（`RunSourceVerifyParams{db,questionId,runTaskFn}`）|
| `runQuizVerify`（per-question，整体调用） | `src/server/boss/handlers/quiz_verify.ts:196`（`RunQuizVerifyParams{db,questionId,runTaskFn}`）|
| matcher 残余生成宿主（已 export） | `src/server/question-supply/dispatcher.ts:208`（`dispatchSupplyTarget`，返 `DispatchResult`）|
| `chooseAutoRoute`（私有，**不裸调**） | `dispatcher.ts:190-201` |
| `QuestionSupplyTarget` 形状（残余适配目标，13 必填字段） | `src/server/question-supply/target-discovery.ts:58` |
| `targetFingerprint`（**已 export，直接 import，需 subjectId**） | `src/server/question-supply/target-discovery.ts:237` |
| `seedRoutePreference`（残余 target 的 routePreference 来源） | `src/server/question-supply/target-discovery.ts:476` |
| `difficultyBandFor`（difficulty band 派生，需 θ̂） | `src/server/question-supply/target-discovery.ts:199` |
| matcher 从 KC resolve subjectId 的先例 | `target-discovery.ts:541`（`resolveSubjectProfile(await getEffectiveDomain(db, kid)).id`）|
| `SourcingNeed`（**`source: SourcingSequenceStep`，与 SupplyRoute 不同构**） | `src/server/quiz/sourcing-sequence.ts:355` |
| `SupplyRoute` 词表（`sourcing_web`/`quiz_gen`/`author_question`/...） | `target-discovery.ts:46` |
| `SourcingSequenceStep` 词表（`external_sourcing`/`material_grounded`/`closed_book`） | `sourcing-sequence.ts:48` |
| `ExistingPoolHit`（`{question_id, source, tier}`，MatchedQuestion superset 基准） | `sourcing-sequence.ts:60` |
| `queryExistingPool`（**inc-2 已迁 poolFetch**，matcher 排序逻辑同源参照） | `sourcing-sequence.ts:84-145` |
| tier 派生 + 排序比较器 | `src/core/schema/provenance.ts:129/188`（`deriveSourceTier` / `compareBySourceTierThenWhitelist`）|
| kind 兼容垫片（**`.ts` 文件**） | `src/subjects/question-kind.ts:86`（`kindsMatch`）|
| `writeEvent`（**在 events/queries，不在 ai/log.ts**） | `src/server/events/queries.ts:1020` |
| FSRS state（**在 fsrs/state，不在 review/fsrs**） | `src/server/fsrs/state.ts:37/72`（`upsertFsrsState`/`getFsrsState`）|
| `initialFsrsState` | `src/capabilities/practice/server/fsrs.ts:62` |
| owner-manual 同形先例（inc-4 抄它） | `src/capabilities/practice/server/proposal-appliers.ts`（`acceptQuestionDraftProposal`，draft→active + FSRS「copied from quiz_verify.ts」+ 409 守门）|
| embed seam | `src/server/ai/embed.ts`（`embedMany`/`embedText`）|
| `draft_status` 三态 enum（NULL≡active） | `src/core/schema/index.ts` |

---

## Tasks（TDD）

> **顺序原则（spec §9 开放问题 4）**：第一段（Task 1-3）先做「纯 active 命中 + 残余生成」骨架——**不依赖 draft verify**，证 matcher 的检索+仲裁+残余三态退化对。第二段（Task 4-5）抽**薄 dispatcher** `verifyAndPromote`（转调现有 verify，不改 handler）+ 接 draft 命中分支。这样 matcher 骨架可独立红→绿，gate 抽象一次到位且有独立回归。

### Task 1: `Demand` / `MatcherResult` 类型 + matcher 骨架（纯 active 命中，无 draft，无残余）
**Files:** Create `src/server/quiz/matcher.ts`, `src/server/quiz/matcher.db.test.ts`

定义 §3.1.5 三层 Demand（v1 子集）+ §2 三态输出契约（superset 兼容 `ExistingPoolHit`）。

```ts
// matcher.ts — v1 Demand（三层；answerClass 字段先收不用）
export interface Demand {
  // ① 硬过滤 → poolFetch WHERE
  knowledgeId: string;                  // 必填，v1 单 KC
  difficultyMin?: number | null;        // 难度带（整数 1-5，poolFetch 标量；R3 caller 算好传入）
  difficultyMax?: number | null;
  compositeParentOnly?: boolean;        // 结构轴 unit==='篇'
  answerClass?: string;                 // gated YUK-395 — v1 收下不进 WHERE（留接口）
  // ② 软排序
  queryText?: string;                   // matcher 内部 embed（路 B）
  queryEmbedding?: number[];            // caller 预算（路 A）；二者都给 Embedding 优先
  minSourceTier?: 1 | 2 | 3;            // 源档底线（R2），喂残余 target + 排序参考
  kind?: string;                        // legacy 垫片（kindsMatch）；随 YUK-386 收口删
  // ③ 信封（不进检索）
  cause?: string;                       // 错因：embed→召回 + 喂残余 generate prompt（经 target.reason 透传）
  gapType?: string;                     // R1-R4：steer 残余路由（映射 SupplyGapKind）
  priority?: number;
  limit: number;                        // 必填
}
export interface MatchedQuestion {       // superset ExistingPoolHit（{question_id, source, tier} + 2 字段）
  question_id: string;
  source: string;
  tier: number;
  promotedFromDraft: boolean;            // false=本来 active；true=本次 gate promote（Task 5 才会 true）
  verifyEventId?: string;                // promote 留痕引用（evidence-first，Task 5）
}
export interface MatcherResult {
  used: MatchedQuestion[];               // active 直接用 + 已 promote 的 draft（同列，返回时 draft_status 永远 active）
  residual: SourcingNeed[];              // 复用 sourcing-sequence.ts 的 SourcingNeed（import，别重定义）
  satisfiedFromPool: boolean;            // 全部 limit 由池满足、无残余
}
```

- [ ] **Step 1 — 失败 db 测试**（`matcher.db.test.ts`）：seed 3 个 **active** question 同一 KC（不同 difficulty，无 embedding）。`matcher(db, {knowledgeId, difficultyMin:3, limit:2})` 返回 `used.length===2`（difficulty≥3、按 created_at 序）、`residual===[]`、`satisfiedFromPool===true`、每个 `MatchedQuestion.promotedFromDraft===false`、`tier`/`source` 正确投影。**红**（matcher 不存在）。
- [ ] **Step 2 — 绿**：实现 matcher 骨架——`poolFetch(db, {knowledgeId, difficultyMin, difficultyMax, compositeParentOnly, activeOnly:false, queryEmbedding})` 取全量候选（**不传 limit** 给 poolFetch，F2 回归防线：截断在 app 层），app 层①`kindsMatch(r.kind, demand.kind)` 过滤（A2 防线，demand.kind===undefined 则不过滤）②`compareBySourceTierThenWhitelist` 排序（合约五）③`.slice(0, limit)`。**本 Task 把所有候选当 active**（poolFetch 不投影 draft_status——见 Task 5 才扩），全填 `used`。**镜像 `queryExistingPool`（`sourcing-sequence.ts:121-145`）的 app 层 kind 过滤 + tier 排序 + slice 链**（同源、单一真相）。
- [ ] **Step 3 — 重构 + 全绿**：抽 `rankPool(rows, demand)` 纯函数（kind 过滤 + tier 排序 + slice），便于单测排序逻辑。`pnpm vitest run --config vitest.db.config.ts src/server/quiz/matcher.db.test.ts`。

> **决策点 — poolFetch 缺 `draft_status` projection（已对 origin/main 核实）**：origin/main `PoolRow`（`pool-fetch.ts:50-60`）只投影 `id/difficulty/source/kind/metadata`，**不含 `draft_status`、不含 distance、不含 embedding**。§3.2 仲裁必须 branch on `draft_status`。Task 1 用 `activeOnly:false` 召回但暂当全 active 是占位；Task 5 接 draft 前必须让 matcher 拿到每行 `draft_status`（同时为 cosine 阈值过滤拿到 distance——见 Task 5 Step 1 合并扩展）。

### Task 2: cosine 软排序（hybrid 检索）+ NULL embedding 降级
**Files:** Modify `src/server/quiz/matcher.ts`, `matcher.db.test.ts`

> **注意**：cosine **阈值过滤**需要 distance projection（origin/main `PoolRow` 没有）。本 Task 先落 **cosine 排序**（poolFetch `ORDER BY embedding <=> qvec` 给序，无需 distance projection）+ 入参解析 + NULL 降级；**cosine 阈值过滤推迟到 Task 5 Step 1 扩 projection 时一起做**（见该步），避免 Task 2 提前动 poolFetch。Task 2 红测只断言**排序**，不断言阈值丢弃。

- [ ] **Step 1 — 失败测试（hybrid 排序）**：seed 3 active question 同 KC，各带不同 embedding（直接 seed 1024d 向量到 `embedding` 列）。`matcher(db, {knowledgeId, queryEmbedding:<近 q2 的向量>, limit:3})` 返回 `used[0].question_id === q2`（cosine 最近优先）。**红**。
- [ ] **Step 2 — 失败测试（queryText 路 B）**：`matcher(db, {knowledgeId, queryText:"...", limit:1}, deps:{embedFn: vi.fn().mockResolvedValue(<vec>)})` 内部调注入的 `embedFn` 一次，把返回向量当 queryEmbedding。断言 `embedFn` 调用次数===1。**红**。
- [ ] **Step 3 — 失败测试（NULL embedding 降级，§7）**：seed 2 active question 一个有 embedding 一个 NULL。传 `queryEmbedding` → poolFetch `isNotNull(embedding)` 会**排除 NULL 行**（origin/main 行为，`pool-fetch.ts` useVector 分支）；matcher 不崩、用回来的有向量行。**额外断言**：不传 `queryEmbedding` 时 NULL 行也召回（退化为纯标量过滤，§7「NULL embedding 降级」）。**红**。
- [ ] **Step 4 — 绿**：matcher 入参解析——`queryEmbedding` 优先（spec §9 开放问题 3）；只有 `queryText` 则 `deps.embedFn(queryText)`（默认 `embedText`，**铁律**：同一 seam，否则 cosine 跨空间无意义）；都无则不排序（poolFetch 退 `created_at,id`）。把得到的向量透传 poolFetch 的 `queryEmbedding`。`deps.embedFn` 是可注入 seam（db 测试注 `vi.fn()`，不打真 DashScope）。
- [ ] **Step 5 — 重构 + 全绿**：cosine 排序由 poolFetch 的 `ORDER BY embedding <=> qvec` 给（app 层 tier 排序在其上**稳定**叠加——`compareBySourceTierThenWhitelist` 对相等 tier 返 0，保留 cosine 序，spec §6「保守排序与 tier 排序需协调」：cosine 取相关性序 → tier 排序在等 tier 内不打乱）。

### Task 3: 残余生成分支（`demandToSupplyTarget` 适配器 + 复用 `dispatchSupplyTarget`）
**Files:** Modify `src/server/quiz/matcher.ts`, `matcher.db.test.ts`

> **类型阻抗（critic 已证）**：`dispatchSupplyTarget` 返 `DispatchResult{ chosenRoute: SupplyRoute }`（词表 `sourcing_web`/`quiz_gen`/...），而 `SourcingNeed.source: SourcingSequenceStep`（词表 `external_sourcing`/`material_grounded`/`closed_book`）——**两者不同构**。`MatcherResult.residual: SourcingNeed[]` 需要 `SourcingSequenceStep`。残余分支用一个**显式 `SupplyRoute → SourcingSequenceStep` 映射表**把 `DispatchResult.chosenRoute` 翻成 `SourcingNeed.source`（见 Step 4），**不**硬塞 SupplyRoute 进 SourcingNeed 类型。

- [ ] **Step 1 — 失败测试（空池 → 残余）**：空库（该 KC 无任何 question）。`matcher(db, {knowledgeId, limit:2}, deps:{dispatch: fakeDispatch})` 返回 `used===[]`、`residual.length>=1`（`SourcingNeed` 形状，`source` 是合法 `SourcingSequenceStep`）、`satisfiedFromPool===false`，且 `fakeDispatch` 被调一次、入参是合法 `QuestionSupplyTarget`（含非空 `knowledgeIds[0]===knowledgeId`、`desiredCount===2`、稳定 `fingerprint`、`subjectId` 非空）。**红**。
- [ ] **Step 2 — 失败测试（部分满足 → 部分残余）**：seed 1 active 命中。`limit:3` → `used.length===1`、`residual` 缺口（`desiredCount`）反映 `3-1`、dispatch 被调（残余补差 gap===2）。**红**。
- [ ] **Step 3 — 失败测试（subjectId resolution）**：seed 1 KC 节点（带 domain），空题池。断言 `demandToSupplyTarget` 产的 `target.subjectId === resolveSubjectProfile(<该 domain>).id`（matcher 经 `getEffectiveDomain(db, knowledgeId)` → `resolveSubjectProfile().id` 解，**不能**留空/硬编码），且 `fingerprint` 含该 subjectId（同 demand 产同 fingerprint，cooldown 前提）。**红**。
- [ ] **Step 4 — 绿**：写 `demandToSupplyTarget(db, demand, gap)` 适配器（**async**，需 DB resolve subjectId）——逐字段映射到 `QuestionSupplyTarget`（13 必填字段，对 `target-discovery.ts:58` 核实）：
  - `id` = 注入的 makeId / `newId()`
  - `subjectId` = `resolveSubjectProfile(await getEffectiveDomain(db, demand.knowledgeId)).id`（**先例 `target-discovery.ts:541`**）
  - `knowledgeIds` = `[demand.knowledgeId]`
  - `kind` = `demand.kind ?? 'any'`
  - `difficultyBand` = 由 difficultyMin/Max 反推（无 θ̂ 时缺省 `'near'`；不引 mastery 依赖，inc-3 简化）
  - `gapKind: SupplyGapKind` = `demand.gapType` 映射（`frontier_zero`/`source_quality`/`diagnostic`/`format_diversity`，缺省 `'frontier_zero'`）
  - `desiredCount` = `gap`
  - `minSourceTier` = `demand.minSourceTier ?? 2`
  - `routePreference` = `seedRoutePreference(<subjectProfile>)`（**import，不硬编码空数组**；空 profile 退 `[]`，dispatcher 会落 manual）
  - `priority` = `demand.priority ?? <base>`
  - `reason` = 含 demand 摘要 **+ `demand.cause`**（cause→prompt 透传缺口，见 Step 5）
  - `constraints` = `{}` 缺省
  - **fingerprint**：调 `targetFingerprint({ subjectId, knowledgeIds:[demand.knowledgeId], kind, difficultyBand, gapKind, minSourceTier })`（**import `targetFingerprint`，绝不复刻算法**——复刻=cooldown 失效=无界付费 re-dispatch；critic 已证原计划「复现 fingerprint 算法」自相矛盾）。
  matcher 残余分支 `await deps.dispatch(db, target)`（默认 `dispatchSupplyTarget`，db 测试注 fake 捕获），把返回的 `DispatchResult` 经 `supplyRouteToSourcingStep(result.chosenRoute)` 映射表翻成 `SourcingNeed{ kind:'question_generation', knowledge_id:demand.knowledgeId, source:<step>, reason:result.reason }` 填 `residual`。
- [ ] **Step 5 — 重构 + 全绿**：`SourcingNeed` 从 `sourcing-sequence.ts` import（**别重定义**）。`SupplyRoute → SourcingSequenceStep` 映射表写成模块级 const（`sourcing_web → external_sourcing`、`quiz_gen → material_grounded|closed_book`（据 `result.routePlan`/`preferredGenerationMethod` 或缺省 `closed_book`）、`author_question/image_candidate/ingest_existing → closed_book`（无对应 step 时的兜底，加注释）），dispatch 返 `manual` 时 `chosenRoute` 可能为 null → 映射表对 null 也产一个兜底 step（如 `closed_book`）并加注释「manual 出口=owner gate，inc-4 闭环」。**cause→prompt 透传缺口**：`QuizGenJobData`/`SourcingJobData` payload 当前不带 `cause`/`answer_class`/难度带——spec §3.1.5 要 `demand.cause` 喂残余 generate prompt，但 inc-3 **不扩 JobData**（避免动两个 handler 契约）；在 `demandToSupplyTarget` 把 `cause` 塞进 `target.reason`（人读字符串，dispatcher 已留痕），加 `// cause→prompt 透传缺口：扩 JobData 是后续增量，见 spec §3.1.5` 注释 + Linear follow-up。

> **三态退化语义一致（§4 + seam④）**：matcher 阈值保守 → 频繁残余 → dispatcher 的 7 天 fingerprint cooldown（`SUPPLY_DISPATCH_COOLDOWN_DAYS`）防无界 re-dispatch（前提=fingerprint 稳定且与 target-discovery 同算法，Step 4 已用 import 的 `targetFingerprint` 保证）。dispatch 若 plan 无可派路由（needsImage / Tavily 缺）→ 返 `manual`（`chosenRoute` 可能非可派路由或 null）→ matcher 把它如实折进 `residual`（owner manual gate 是闭环出口，inc-4）。

---

> **第一段（Task 1-3）完成 = matcher 骨架可独立 merge**：纯 active 命中 + cosine 排序 + 残余生成三态退化全绿，**不依赖任何 draft verify、不碰任何 handler**。这是「今天的行为加了语义召回」（spec §2）的最小可证形态。第二段接 draft。

---

### Task 4: 薄 dispatcher `verifyAndPromote`（caller-agnostic gate，转调现有 verify）
**Files:** Create `src/server/quiz/verify-and-promote.ts`, `verify-and-promote.db.test.ts`
**不改任何 handler 文件**（(b1) 决策）。

签名（收 questionId，内部转调现有 per-question run 函数）：

```ts
import type { RunTaskFn } from '@/server/boss/handlers/quiz_verify'; // 同形于 source_verify 的 RunTaskFn
export interface VerifyAndPromoteParams {
  db: Db;
  questionId: string;                    // 转调的 run 函数内部 re-SELECT（保留现有幂等/守门契约）
  runTaskFn: RunTaskFn;                  // 透传给被转调的 run 函数（db 测试注 vi.fn()）
  actor?: { kind: 'agent' | 'user'; ref: string };  // 默认 agent；owner manual（inc-4）传 user
  skipVerify?: { reason: string };       // override：跳 AI verify，直接 promote（inc-4 owner path，inc-3 实现+测）
  // dispatch seam：默认转调真实 runSourceVerify/runQuizVerify；db 测试可注入 fake 验「派到哪个」
  deps?: { runSourceVerify?: typeof runSourceVerify; runQuizVerify?: typeof runQuizVerify };
}
export interface VerifyAndPromoteResult {
  promoted: boolean;                     // run 函数 status==='verified'（quiz 的 needs_review/failed → false）
  status: string;                        // 透传 run 函数 status（'verified'|'needs_review'|'failed'|'skipped:*'）
  verifyEventId?: string;                // promote 留痕引用（见下「verifyEventId 来源」）
  reason?: string;                       // 不 promote 的状态/驳回理由
}
export async function verifyAndPromote(p: VerifyAndPromoteParams): Promise<VerifyAndPromoteResult>;
```

**dispatch 设计（薄派发，按 source 字面选 verify，不重实现）：**

1. **re-SELECT row 取 `source` + `draft_status`**（一次轻量 SELECT id/source/draft_status）。
2. **override 分支（`skipVerify`）**：若传 `skipVerify` → **不调 run 函数**，自己跑 promote：在 txn 内 `draft→active` + FSRS enroll-if-absent（复用 `getFsrsState`/`upsertFsrsState`/`initialFsrsState`，与 run 函数同款）+ `writeEvent`（按 source 派生 action `experimental:source_verify`/`experimental:quiz_verify`，`actor_kind:'user'`、payload `skipped_verify:true`+`reason`）。**这是 inc-3 唯一需要 verifyAndPromote 自己写 promote 的分支**（因为 owner override 跳过 verify，没有 run 函数可转调）；它直接复用 `proposal-appliers.ts:acceptQuestionDraftProposal` 的 draft→active+FSRS 同形逻辑（参照，非 import）。`verifyEventId` = 这条 event 的 id。**inc-3 实现函数 + 测它**，UI/route 入口是 inc-4。
3. **正常分支（无 `skipVerify`）= 薄派发**：按 `source` 转调——
   - `source === 'web_sourced'`（或 `deriveSourceTier` tier ∈ {1,2}）→ `runSourceVerify({db, questionId, runTaskFn})`
   - `source === 'quiz_gen'`（或 tier ∈ {3,4}）→ `runQuizVerify({db, questionId, runTaskFn})`
   - 其它 source → `{promoted:false, status:'skipped:unsupported_source'}`（防御；现实只有这两个 source 进 draft verify）
   把 run 函数返回的 `status` 映射成 `VerifyAndPromoteResult`：`promoted = (status === 'verified')`；`status` 透传；`reason` = status（needs_review/failed/skipped:* 时）。
   **三态 / writeAgentNote note / metadata 写回 / catch / 幂等 / 非-draft 守门全部由被转调的 run 函数天然产生**——verifyAndPromote 一行不重实现。
4. **`verifyEventId` 来源**：现有 `RunSourceVerifyResult`/`RunQuizVerifyResult` **不返 verify event id**（只返 status/checks/overall）。inc-3 的 matcher 需要 `verifyEventId` 留痕（`MatchedQuestion.verifyEventId`）。两条路径，**实现期二选一并写明**：
   - **(a) 转调后回查**：run 函数转调完，若 `promoted`，按 `(action, subject_kind='question', subject_id=questionId, outcome != 'error')` 查最新 verify event 取 id（幂等查的同款谓词，已是 run 函数内部用的索引路径）。**推荐**（零改 handler，与 (b1) 决策一致）。
   - (b) override 分支自产的 event id 直接返。
   →选 (a)，加注释「run 函数不返 event id，promote 后回查；改 run 函数返 id 是后续 cleanup」+ Linear follow-up。**不要为拿 id 去改 handler 签名**（破 (b1) 等价回归）。

- [ ] **Step 1 — 失败测试（派到 source_verify）**：seed `source='web_sourced'` 的 **draft** question。`verifyAndPromote({db, questionId, runTaskFn, deps:{runSourceVerify: spyA, runQuizVerify: spyB}})` → `spyA` 被调一次（入参 `{db, questionId, runTaskFn}`）、`spyB` 0 次。**红**（verifyAndPromote 不存在）。
- [ ] **Step 2 — 失败测试（派到 quiz_verify）**：seed `source='quiz_gen'` draft。同上断言 `spyB` 调一次、`spyA` 0 次。**红**。
- [ ] **Step 3 — 失败测试（透传 status→promoted）**：注 `runSourceVerify` fake 返 `{status:'verified'}` → `verifyAndPromote` 返 `{promoted:true, status:'verified'}`；注返 `{status:'failed'}` → `{promoted:false, status:'failed', reason 非空}`；注 quiz fake 返 `{status:'needs_review'}` → `{promoted:false, status:'needs_review'}`（三态如实透传）。**红**。
- [ ] **Step 4 — 失败测试（override 留痕，真实 run 不被调）**：seed `source='quiz_gen'` draft。`verifyAndPromote({db, questionId, runTaskFn:<不该被调>, actor:{kind:'user',ref:'owner'}, skipVerify:{reason:'owner 判断'}, deps:{runQuizVerify:<不该被调的 spy>}})` → `promoted===true`、DB 行 `draft_status==='active'`、FSRS card materialized、写了 `experimental:quiz_verify` event（`actor_kind:'user'`、payload `skipped_verify:true`+`reason`）、**`runTaskFn` 与注入的 run spy 均 0 次调用**。**红**。
- [ ] **Step 5 — 失败测试（verifyEventId 回查）**：seed `source='web_sourced'` draft + 注 `runSourceVerify` fake：fake **真把 draft promote 成 active 并写一条 source_verify event**（或用真实 `runSourceVerify` + `runTaskFn` 返 pass，整链跑通），断言 `verifyAndPromote` 返的 `verifyEventId` 指向那条 event。**红**。
- [ ] **Step 6 — 绿**：实现 `verifyAndPromote`（薄派发 + override 分支 + verifyEventId 回查）。**不 import 任何 promote/check 内部实现**，只 import `runSourceVerify`/`runQuizVerify`（正常分支）+ `writeEvent`/`getFsrsState`/`upsertFsrsState`/`initialFsrsState`/`deriveSourceTier`（仅 override 分支用）。
- [ ] **Step 7 — 重构 + 全绿**：`pnpm vitest run --config vitest.db.config.ts src/server/quiz/verify-and-promote.db.test.ts`。**额外硬证据**：跑 `source_verify.db.test.ts` + `quiz_verify.db.test.ts` 既有测试**全绿**——因为 (b1) 一行没改 handler，它们必然全绿；跑一遍是证明「未误触 handler」（不是等价回归证明，因为没有提取）。

> **三 caller 共用证明**：matcher（lazy，Task 5）、owner manual override（Step 4 测了 `skipVerify` 函数路径，UI=inc-4）、未来 pre-warm（现有 eager 链不变，可选优化）——前两者全经 `verifyAndPromote` 入口；现有 eager 链直接调 run 函数（也是同一逻辑）。全 branch on `draft_status`，全零新 schema 字段（override 的 payload 加 key 不算 schema 变更，spec §3.3 line 114）。这印证 spec §3.3「gate=操作」，且**零 handler 改动**。

### Task 5: matcher 接 draft 命中分支 + cosine 阈值过滤（`PoolRow` 扩 projection + lazy `verifyAndPromote`）
**Files:** Modify `src/server/quiz/pool-fetch.ts`, `src/server/quiz/matcher.ts`, `matcher.db.test.ts`

- [ ] **Step 1 — 扩 `PoolRow` 加 `draft_status` + `cosine_distance` projection（additive，一步做完）**：`src/server/quiz/pool-fetch.ts` select 加：
  - `draft_status: question.draft_status`（`PoolRow` 加 `draft_status: string | null`，注释「inc-3 matcher reads draft_status to branch active/draft (§3.2)」）。
  - `cosine_distance`：当 `useVector`（传了 queryEmbedding）时投影 `sql<number>\`${question.embedding} <=> ${toSqlVector(...)}::vector\`` 为 `cosine_distance`；不传 queryEmbedding 时该列为 `null`（`PoolRow` 加 `cosine_distance: number | null`，注释「inc-3 matcher reads distance for cosine threshold filter (§4); 与 ORDER BY 同源单一真相，类比 inc-2 扩 source/kind/metadata projection」）。
  **不动 WHERE/ORDER**——inc-1/2 caller（`queryExistingPool` 只读 id/difficulty/source/kind/metadata，`sourcing-sequence.ts:139-145`）不受影响。跑 `pool-fetch.db.test.ts` + `sourcing-sequence`/`sourcing-pool-equivalence` 测试**全绿**（additive 不回归）。
- [ ] **Step 2 — 失败测试（cosine 超阈 → 残余，§4 边界，critic non-blocker 6）**：seed 1 **active** question 命中 KC 但 embedding 与 query 向量**远**（cosine distance > 阈值）。`matcher(db, {knowledgeId, queryEmbedding:<远向量>, limit:1}, deps:{dispatch:fake})` → 该 active 行**被阈值丢弃**、`used===[]`、`residual.length>=1`（落残余生成）、dispatch 被调。**这条钉死「宁残余不塞次品」（spec §4 owner 决策 2）是有意行为**——防 `MATCHER_COSINE_MAX_DISTANCE` 初值过严静默吞整池被误当 bug「修」。**红**。
- [ ] **Step 3 — 失败测试（draft 命中 → promote → USE）**：seed 1 **draft** question 同 KC（带 embedding 命中、distance 达阈），注 `deps.verify` 返 `{promoted:true, verifyEventId:'ev1'}`。`matcher(db, {knowledgeId, limit:1}, deps:{verify})` → `used.length===1`、`used[0].promotedFromDraft===true`、`used[0].verifyEventId==='ev1'`、`verify` 被调一次（入参 `{db, questionId:<该 draft id>, runTaskFn}`）。**红**。
- [ ] **Step 4 — 失败测试（draft 不过 gate → 看下一候选）**：seed 2 候选——draft（命中但 verify 注 `{promoted:false}`）+ active（命中）。matcher 跳过验证失败的 draft、用 active；`used[0]` 是 active 行、`used[0].promotedFromDraft===false`。**红**。
- [ ] **Step 5 — 失败测试（全候选耗尽 → 残余）**：seed 1 draft（verify 注 fail），无 active。matcher → `used===[]`、`residual.length>=1`（落 Task 3 残余）、dispatch 被调。**红**。
- [ ] **Step 6 — 绿**：
  - 引入常量 `MATCHER_COSINE_MAX_DISTANCE`（pgvector `<=>` 是距离，越小越近；保守=偏严=阈值偏小）。`rankPool` 后、仲裁循环前，**当有 queryEmbedding 时**丢弃 `cosine_distance != null && cosine_distance > MATCHER_COSINE_MAX_DISTANCE` 的候选（无 queryEmbedding → distance 全 null → 不按阈值过滤，纯标量集）。留 `// TODO 实测调参` + Linear follow-up。
  - 仲裁循环按 §3.2：`rankPool` + 阈值过滤后逐候选——`draft_status` 为 NULL/'active' → 直接 `used.push({...promotedFromDraft:false})`；为 'draft' → `await deps.verify({db, questionId:cand.id, runTaskFn})`（默认 `verifyAndPromote`，db 测试注 fake），`promoted` 则 `used.push({...promotedFromDraft:true, verifyEventId})`，否则跳下一候选。凑够 `limit` 停；耗尽仍不足 → 残余补差（Task 3 的 `demandToSupplyTarget` + dispatch）。
- [ ] **Step 7 — 重构 + 全绿**：lazy verify 在命中 draft 时引入一次 LLM verify 延迟（spec §9 开放问题 5，v1 接受，pre-warm 缓做）。`pnpm vitest run --config vitest.db.config.ts src/server/quiz/matcher.db.test.ts src/server/quiz/pool-fetch.db.test.ts`。

---

## Demand 输入：v1 实现 / defer 对照（§3.1.5）

| Demand 字段 | 层 | v1 | 备注 |
|---|---|---|---|
| `knowledgeId` | ① 硬 | ✅ 实现 | 必填，进 poolFetch `knowledge_ids @> [id]` + 残余 subjectId resolve 锚 |
| `difficultyMin/Max` | ① 硬 | ✅ 实现 | 整数 1-5 标量；R3 caller 由 θ̂+effectiveB 派生 near-θ̂ band 传入 |
| `compositeParentOnly` | ① 硬 | ✅ 实现 | poolFetch `unit==='篇'` |
| `answerClass` | ① 硬 | ⏸ **收下不用** | **gated YUK-395**——字段留接口，不进 WHERE，`// gated YUK-395` |
| `queryEmbedding` | ② 软 | ✅ 实现 | 路 A（caller 读现成 KC/question 向量）；优先 |
| `queryText` | ② 软 | ✅ 实现 | 路 B（matcher 内部 `embedText`，可注入 seam）|
| `minSourceTier` | ② 软 | ✅ 实现 | 喂残余 `demandToSupplyTarget.minSourceTier` |
| `kind` | ② 软 | ✅ 垫片 | `kindsMatch` A2 防线；**随 YUK-386 收口删** |
| `cause` | ③ 信封 | ⚠️ 部分 | 残余经 `target.reason` 透传（JobData 不扩，缺口标注）|
| `gapType`/`priority` | ③ 信封 | ✅ 实现 | gapType→SupplyGapKind 映射喂残余；priority 喂 target |
| `limit` | — | ✅ 实现 | 必填 |

**复合阈值落地总结（§4）**：① **硬过滤**（KC + 难度 + compositeParent）走 `poolFetch` 标量谓词；answer_class 硬过滤 **defer YUK-395**。② **cosine 软排序**由 poolFetch `ORDER BY embedding <=> qvec` + matcher app 层阈值常量 `MATCHER_COSINE_MAX_DISTANCE` **过滤**（用 Task 5 扩的 `cosine_distance` projection，与 ORDER BY 同源单一真相；偏严=保守）。③ **tier 排序** `compareBySourceTierThenWhitelist` 在等 tier 内稳定叠加（不打乱 cosine 序）。**阈值不达 → 候选不入保守集 → 残余生成**（Task 5 Step 2 钉死此边界）。

---

## A5 / A2 不变量守卫（§7）

- [ ] **只读 `draft_status` 判别 active/draft**：matcher 不引入任何 harvested/raw 来源 tag（spec §3.1）。仲裁循环唯一判别 = `cand.draft_status`。
- [ ] **不写 `judge_kind_override`、不动 judge routing**：matcher 用 answer_class 做命中硬过滤是验证轴语义（A5），**不碰** `route-resolve.ts` profile 路由。grep 确认 matcher.ts + verify-and-promote.ts 无 `judge_kind_override` 写路径。
- [ ] **不破坏 A2 tier 排序**：matcher 在 poolFetch 之上**重新 apply** `kindsMatch` 过滤（防 `reading` 池短路 `computation`）+ `compareBySourceTierThenWhitelist`（合约五，authentic-first）+ `slice` AFTER sort（poolFetch 不传 limit，F2 防线）。这是 pool-fetch.ts INCREMENT-2 MIGRATION CONTRACT 对所有 poolFetch 消费者的硬要求；matcher 的链镜像 `queryExistingPool`（`sourcing-sequence.ts:121-145`）。
- [ ] **NULL embedding 降级**：传 queryEmbedding 时 poolFetch 排除 NULL 行（该行无语义召回，不崩）；不传时退纯标量过滤（§7）。
- [ ] **evidence-first 留痕**：promote 决策可追溯可回滚——正常分支由被转调 run 函数写 verify event（matcher 回查取 verifyEventId 引用）；override 分支 verifyAndPromote 自写 `actor_kind:'user'`+`skipped_verify:true` event（`@/server/events/queries` writeEvent，遵 `src/server/ai/log.ts` 约定的 evidence-first 原则，但 event 写入走 events/queries）。
- [ ] **不改 handler 等价性**：(b1) 决策下 `source_verify.ts`/`quiz_verify.ts` 零改动；Task 4 Step 7 跑两 handler 既有测试全绿证明「未误触」。

---

## 依赖标注

| 能力 | v1 跑 | 等 |
|---|---|---|
| KC + 难度 + cosine（排序+阈值）+ tier 排序仲裁 | ✅ | — |
| draft 命中 lazy verify-promote（转调现有 verify） | ✅ | — |
| 残余生成（复用 dispatchSupplyTarget，SupplyRoute→Step 映射） | ✅ | — |
| `verifyAndPromote` 薄 dispatcher（含 override 函数路径） | ✅ | — |
| **answer_class 硬过滤** | ❌ | **YUK-395**（新鲜度 on-write/re-derive）|
| **kind 垫片删除** | ❌（v1 保留） | **YUK-386**（两轴正交 Step 5 ship）|
| cause→残余 prompt（扩 JobData） | ❌（v1 经 reason 透传） | 后续增量 |
| owner manual UI/route | ❌（inc-3 只抽函数 + override 分支） | **inc-4** |
| pre-warm job | ❌ | 可选优化（spec §3.3）|
| forager + 预筛 | ❌ | inc-5 |
| matcher 接 LIVE 消费侧 | ❌ | 后续（现 `runSourcingSequence` 无 caller）|
| verifyEventId 由 run 函数直接返（免回查） | ❌（v1 回查） | cleanup（改 run 函数返 id）|

---

## 验收（pre-PR gate）

- [ ] `matcher.db.test.ts` 全绿：active 命中、cosine 排序、queryText 路 B、NULL 降级、cosine 超阈→残余（§4 边界）、残余生成、部分残余、subjectId resolution、draft 命中-promote、draft fail-跳过、耗尽-残余。
- [ ] `verify-and-promote.db.test.ts` 全绿：派到 source_verify、派到 quiz_verify、status→promoted 透传（含 needs_review）、override 留痕（真实 run 不被调）、verifyEventId 回查。
- [ ] **未误触 handler 证据**：`source_verify.db.test.ts` + `quiz_verify.db.test.ts` 既有测试**全绿**（(b1) 零改 handler，应天然全绿；跑一遍证明 verifyAndPromote 的转调未引入副作用）。
- [ ] `pool-fetch.db.test.ts` + `sourcing-sequence`/`sourcing-pool-equivalence` 测试在 `PoolRow` 加 `draft_status`+`cosine_distance` projection 后全绿（additive 不回归）。
- [ ] 不变量守卫 6 条全勾。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm audit:schema`、`pnpm audit:partition`、`pnpm audit:draft-status`（matcher/verifyAndPromote 不新 INSERT question，应天然过；override 分支只 UPDATE draft_status→active，复用既有 write path，确认 audit:schema 不报新漂移）、`pnpm test`、`pnpm build` 全过。
- [ ] db 测试 hermetic：每个 `beforeEach` `resetDb()`，不假设跨文件状态/执行序。

---

## 风险 / Gotcha

1. **`poolFetch` 缺 `draft_status` + distance projection**（已对 origin/main 核实）：origin/main `PoolRow`（`pool-fetch.ts:50-60`）只投影 `id/difficulty/source/kind/metadata`。§3.2 仲裁要 `draft_status`、§4 阈值要 distance。Task 5 Step 1 一次性 additive 扩两列（与 inc-2 扩 source/kind/metadata 同性质）。
2. **cosine 阈值标定**：`MATCHER_COSINE_MAX_DISTANCE` 初值无生产数据支撑，靠 db 测试 seed 向量经验标定。**保守=偏严=阈值偏小，宁残余不塞次品**（§4 owner 决策 2）；Task 5 Step 2 用「active 命中但超阈→残余」边界测试钉死此有意行为（防初值过严被误当 bug 删）。留 `// TODO 实测调参` + Linear follow-up。
3. **fingerprint 稳定性 + subjectId 解析**（seam④ 隐性契约）：`demandToSupplyTarget` 必须 **import `targetFingerprint`**（`target-discovery.ts:237`），**绝不复刻算法**——复刻=cooldown 失效=无界付费 re-dispatch。fingerprint 需 `subjectId`，但 Demand 只有 `knowledgeId`——matcher 经 `resolveSubjectProfile(await getEffectiveDomain(db, knowledgeId)).id` 解（先例 `target-discovery.ts:541`）。Task 3 Step 3 db 测试断言 subjectId 正确 + 同 demand 产同 fingerprint。
4. **SourcingNeed ↔ SupplyRoute 词表不同构**（critic 已证）：`dispatchSupplyTarget` 返 `DispatchResult.chosenRoute: SupplyRoute`，`MatcherResult.residual: SourcingNeed[]` 要 `source: SourcingSequenceStep`。Task 3 Step 5 用显式 `SupplyRoute→SourcingSequenceStep` 映射表翻译，**不**硬塞类型。
5. **verifyEventId 回查**（非阻断，但需写明）：run 函数不返 verify event id；matcher 需 verifyEventId 留痕。inc-3 在 verifyAndPromote 内 promote 后按幂等查谓词回查取 id（**不改 run 函数签名**，否则破 (b1) 等价）。改 run 函数返 id 是 cleanup follow-up。
6. **本地 vs origin 偏差**：inc-1/2（poolFetch + 迁移）**已在 `origin/main`**（inc-2 也已 merge——`sourcing-sequence.ts:113` 头注释 YUK-398 inc-2 证实），本地 working tree 落后。**worktree 必须从 origin/main 起**，否则 matcher 无检索底座（`pool-fetch.ts` 不存在）。
7. **cause→prompt 透传缺口**：JobData 不带 cause，spec §3.1.5 要它喂残余 generate prompt。inc-3 经 `target.reason` 透传（弱）；扩 JobData 是后续增量 + Linear follow-up。
8. **action 串不合并**：verifyAndPromote 正常分支转调现有 run 函数 → 它们各自写 `experimental:source_verify` / `experimental:quiz_verify`（不合并成单 `experimental:verify`）。override 分支也按 source 派生这两个 action。合并要迁历史事件 + 改 `agency/ui/meta.ts` 消费者，超 inc-3 scope。
9. **薄 dispatcher 的边界纪律**：`verify-and-promote.ts` **只能** import `runSourceVerify`/`runQuizVerify`（正常分支转调）+ 少量 promote 原语（仅 override 分支用）。**绝不** import 或复制两 handler 的 check 逻辑 / promote 事务 / metadata 构造 / writeAgentNote——那是「合并抽取」的滑坡，被本决策否决。code review 时 grep `verify-and-promote.ts` 确认无 `checkStructureCompleteness`/`parseQuizVerifyOutput`/`writeAgentNote`/`maxNgramOverlap` 等 handler 内部符号。

---

## Linear 闸（实现完成前）

实现阶段须建/更新以下 follow-up（搜重后）：
- **cosine 阈值实测调参**（`MATCHER_COSINE_MAX_DISTANCE` 初值靠测试标定，需生产数据回校）——关联 YUK-396。
- **cause→残余 generate prompt 透传**（扩 `QuizGenJobData`/`SourcingJobData` 带 cause/answer_class/难度带）——关联 YUK-396 / 残余生成。
- **verifyEventId cleanup**（让 `runSourceVerify`/`runQuizVerify` 直接返 verify event id，免 verifyAndPromote 回查）——非 inc-3 scope，独立 cleanup issue。
- **verify action 串合并 + metadata 写回统一**（cleanup：单 `experimental:verify` action + tier 2 也写 verification 块）——非 inc-3 scope，独立 cleanup issue。
- inc-4（owner manual gate UI/route）、inc-5（forager）已由 spec §8 + YUK-396 追踪，无需新开。
