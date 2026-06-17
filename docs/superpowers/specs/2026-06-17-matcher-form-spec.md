# Matcher 形态 spec — harvest-then-match 的承重墙

> 自主 drive 2026-06-17 起草，**refines** `docs/superpowers/specs/2026-06-16-acquisition-rethink-retrieval-substrate-design.md`（下称「采集 spec」）§3 / §4.4 / §9。本文档不重述采集 spec 的动机与全局架构，只把 matcher 的**具体形态 + gate 设计**钉死，并显式记录对采集 spec 的 delta（owner 对话 2026-06-17 拍板）。
>
> **关联**：YUK-361（选题/校准/供给主线）、采集 spec 决策 3（matcher 形态）/ 决策 4（raw 池免审 promote 过 verify）、ADR-0038（verify）、Phase 0 检索底座（pgvector 列 + embedder + backfill + GIN，#439）、Phase 1 inc-1 `poolFetch` 算子（#447 已 merge）。

## 1. 定位（继承采集 spec §3）

matcher = 给定一个 **demand**（KC × 难度带 × answer_class × 错因/kind），在题库里做语义检索 + 仲裁，输出「用现成的 / 验证并启用一道半成品 / 残余丢给生成」。它是 harvest-then-match 循环的承重墙，也是采集 spec §3.2 三 seam 的中枢：

```
                gap 扫描（discoverSupplyTargets，已 LIVE）
                        │ drive
              forager ──┤（后台持续囤料 → draft 池）        ← 附加件，可缺省
                        │
   demand ─────────────▶ matcher（本 spec）
                        │  ├─ Seam① steer forager 优先级
                        │  ├─ Seam② 扫池命中 → 仲裁
                        │  └─ Seam③ 残余 → 生成
                        ▼
                   verify 闸(B5) = caller-agnostic gate（§3）
```

## 2. 统一模型（owner 对话 delta，B⊃A）

采集 spec 把 forager 和 matcher 并列描述，易读成「两个分支」。**owner 校正：matcher 是一个东西，不分 A/B 支；forager 是独立附加件。**

- **matcher = demand ↔ 题库（active + draft）的语义仲裁**。它不依赖 forager 存在：draft 池为空时，matcher 优雅退化为「检索 active 命中 → 命不中就纯生成」——就是今天的行为加了语义召回。
- **forager 是 additive enhancement**：持续囤料填 draft 池，让 matcher 的「命中 draft」分支有货。先上 matcher、后上 forager 不破坏任何东西。
- 采集 spec §9 的「语义缺口检测」不是独立模块 = matcher 的 no-match 分支。

## 3. 核心形态：caller-agnostic 仲裁器 + 单一 gate

### 3.1 判别轴 = `draft_status`，不是来源（owner 对话 delta）

matcher **只 branch on `draft_status`（active vs draft），永不看「料从哪来」**。这条是上一轮「1/3 矛盾」的解：一旦判别轴是已有的 `draft_status`，就不需要任何 harvested/raw tag，也不存在 request/harvest 渠道分裂。

> **Delta vs 采集 spec §9**：spec 列「raw 原料池 schema（候选半成品 + 状态机 raw→matched→promoted/discarded + fingerprint 去重）」为待建。**owner 校正：不另立 raw 池表。** raw 池 = `question` 表的 **draft 切片**（`draft_status = 'draft'`，Phase 0 已对 draft 一并 embed，`poolFetch({activeOnly:false})` 直接查得到）。状态机塌缩成现有的 `draft → (verify) → active`，fingerprint 去重落在 forager 的录入侧预筛（§5），不需要独立状态列。

### 3.1.5 输入契约：Demand（owner 对话 2026-06-17）

matcher 收一个 **Demand**，按用途分三层。**matcher 是 caller-agnostic 机制：语义由 caller 经「硬过滤 + query 向量 + 信封」注入，matcher 不关心 demand 从哪个消费者来。**

```
Demand {
  // ① 硬过滤 → 直接进 poolFetch 的 WHERE
  knowledgeId: string            // KC，必填。v1 单 KC（跨 KC/domain 池 = open question）
  answerClass?: AnswerClass      // 验证形态硬约束（exact/keyword/semantic/steps）。gated on YUK-395
  difficultyMin?, difficultyMax? // 难度带。R3 由 mastery θ̂(YUK-361)+effectiveB 派生 near-θ̂ band，caller 算好传入
  compositeParentOnly?: boolean  // 结构轴：篇 vs 题（= unit==='篇'）

  // ② 软排序 → 复合阈值的语义侧
  queryText?: string             // matcher 内部 embed（单点 caller 省事）
  queryEmbedding?: number[]      // 预算好的向量（批量 caller 省调用）；二者都给则 Embedding 优先
  minSourceTier?: SourceTier     // 源档底线（R2），喂 compareBySourceTierThenWhitelist

  // ③ demand 信封 → 不进检索，用于 steer forager(seam①) + 残余生成(seam③)
  cause?: string                 // 错因：既喂 query 向量（embed→召回探该错因的题）又喂残余 generate prompt
  gapType?, priority?            // R1-R4：steer forager + 残余路由选 route
  limit: number                  // 要几道
}
```

**query 向量多态**（embed 什么由 caller 定，matcher 只收向量）：R1 覆盖缺口→embed KC 内容（`knowledge.embedding`，YUK-383 已落）；错因复发→`embed(cause)`；R4 迁移→`embed(场景)`；「错因→题检索」消费者→`embed(cause)`。

**caller 怎么算 queryEmbedding**（grounded in `src/server/ai/embed.ts` + `embed-source.ts`）—— 铁律：必须出自同一 seam `embedText()`/`embedMany()`（`text-embedding-v4`@1024，DashScope），否则不同空间 cosine 无意义。两条路：
- **路 A 读现成向量（零 API）**：查询目标是已 embed 的实体（KC / 现有 question）→ SELECT 其 `embedding` 列当 queryEmbedding。R1 nightly 扫 gap 全走此路（KC 向量 Phase 0 已 backfill），matcher 在此路零 embedding 调用。→ 传 `queryEmbedding`。
- **路 B 现算（一次 embedding 调用，比 LLM 便宜 1-2 量级）**：查询目标是自由文本（错因/场景）→ `embedText(text)`，批量用 `embedMany`（自动按 10 chunk）。→ 传 `queryText`，matcher 内部 embed。

**gotcha**：① 跨类型相似度偏粗——KC 向量 embed `name+domain`（短）vs question 向量 embed `prompt+reference+choices`（富），R1 路能 work 但粗；错因/场景用富文本现算召回更准。② 版本一致性——存量盖 `embed_model`/`embed_version`，matcher 理想只跟当前版行比距离；叠加 YUK-393（编辑后陈旧）+ YUK-395 = freshness 前置。③ 无 query/document 不对称（embed 请求体无 `text_type`，query/doc 同空间）。

**kind 过渡**：旧 `queryExistingPool` 收 `kind` 做 `kindsMatch`；YUK-386 两轴正交后验证轴=`answerClass`、结构轴=`compositeParentOnly`，`kind` 是 legacy。YUK-386 未全 ship（Step 5 待），过渡期 matcher 留 kind/kindsMatch 兼容垫片，随 YUK-386 收口删除。

### 3.2 仲裁流程

```
matcher(demand):
  pool = poolFetch(db, {
    knowledgeId, difficultyMin, difficultyMax,
    queryEmbedding,            // hybrid：有则 cosine 排序
    activeOnly: false,         // active + draft 一起召回
  })
  rank = 保守排序(pool, demand)          // §4
  for cand in rank:                      // 保守阈值内的候选，按序
    if cand.draft_status == active:
      return USE(cand)                   // 直接用
    else:                                // draft → 过 gate
      if gate.verifyAndPromote(cand):    // §3.3，B5 verify
        return USE(cand)                 // 过 → promote active + 用
      // 不过 → 看下一候选
  return RESIDUAL_GENERATE(demand)       // 池中无可用 → 残余路由生成（复用 chooseAutoRoute）
```

- **保守**（owner 决策 2）：`rank` 只纳入命中判据达阈值的候选；阈值偏严，宁走 `RESIDUAL_GENERATE` 也不塞次品。阈值具体判据见 §4。
- matcher 不分渠道：active 命中直接用，draft 命中过 gate，no-match 生成——三条路只看 `draft_status` + 命中分。

### 3.3 Gate = 一个操作，三个 caller（owner 对话 delta + 本次新增 manual path）

gate ≡ `verifyAndPromote(question)`：对一条 `draft_status='draft'` 的行跑 B5 verify（复用现有 `quiz_verify`/`source_verify` per-source handler），过则 `draft_status → active`，不过留 draft 并记驳回理由。**三个 caller 全部 branch on `draft_status`、全部零新字段**：

| caller | 触发 | 时机 | 状态 |
|---|---|---|---|
| **matcher** | 命中 draft 候选 | lazy（命中才验）| v1 baseline |
| pre-warm job | 后台扫高价值 draft 提前 promote | eager | 可选，后续优化（降命中延迟）|
| **owner manual** | owner 在 draft 池挑题主动启用 | 随时 | v1（owner 要的 path）|

> **Delta vs 采集 spec §3 兜底闸**：spec 写「promote（来自池）或生成（来自残余）统一过 verify-then-promote」。本 spec 把它具象成 **caller-agnostic 操作**——gate 不绑某个触发器。lazy（matcher）是 v1 baseline；request-then-fulfill 自然折进来（其 demand 是活的，matcher 几乎立刻验它那条 draft，「看起来 eager」纯因需求当场在，非另一条 verify 路径）。现有 eager `source_verify`/`quiz_verify` 链可保留为 pre-warm 优化，**v1 不强拆**。

#### owner manual path（本次新增）两档

1. **审核并启用**：owner 选一条 draft → 跑同一个 B5 verify → 过：active / 不过：展示驳回理由，留 draft。
2. **强制启用（override）**：跳过 AI verify，owner 判断即 gate，但**留痕**（evidence-first：记 `actor=owner, skipped_verify=true, reason`，可追溯可回滚——遵守 `docs/architecture.md` evidence-first + `src/server/ai/log.ts` 既有留痕约定）。

manual path 是 gate 的第三个 caller，印证「gate=操作」设计：加它不需任何 schema 变更，不破坏统一性。

## 4. 命中判据 / 保守阈值（owner 2026-06-17 拍板：复合）

**复合判据**（非纯 cosine）：硬过滤（KC containment + 难度带 + answer_class 匹配，全部走 `poolFetch` 的标量谓词）**之上**再按 cosine 距离排序 + 阈值。即「先标量收窄候选集，再语义排序取保守 top」。owner 否决了纯 cosine——纯 cosine 会让验证形态不符的题（要 `steps` 却召回 `exact`）混进保守集。

- answer_class 匹配是**硬约束**：demand 要 `steps` 的不能拿 `exact` 题充数（A5 验证轴语义，answer_class 是验证轴，不动 judge routing）。
- 难度带是**软偏好或硬带**：落带内优先，可放宽 ±1。
- cosine 阈值偏严（owner 决策 2 保守）：达不到就走残余生成。

> **依赖 YUK-395**：matcher 把 answer_class 进硬过滤，需先解 answer_class 新鲜度（on-write@insert + re-derive@edit），否则读到 NULL/陈旧类。Phase 1 inc-1 `poolFetch` 已显式把 answer_class 过滤 **gate 在 YUK-395 之后**（见 `src/server/quiz/pool-fetch.ts` 头注释）。matcher v1 可先用 KC+难度+cosine 跑通，answer_class 硬过滤随 YUK-395 落地再开。

## 5. harvest 侧（forager + 廉价预筛，附加件）

forager 持续囤 authentic 料 → **廉价确定性预筛（无 LLM）** → 插入 draft 池：

- 预筛 = n-gram/embedding 去重（复用现成 n-gram dedup + Phase 0 embedding）+ 结构合法性（有 prompt/answer 骨架）+ source-tier 标注。
- 预筛**不是 gate**（无 LLM verify），只防垃圾进检索池，保证 matcher 检索质量。真正的 B5 verify 仍在 matcher 命中时（§3.3）。
- forager 受 gap 扫描 steer（Seam①，采集 spec §3.2 表）：缺哪个 KC / minSourceTier / 哪种 kind，就定向囤。

forager 是 Phase 1 后段增量，matcher 核心不依赖它（§2）。

## 6. 与现有代码的关系 / 重构面

- **`poolFetch`（#447 已 merge）** = matcher 的检索底座。matcher 调它拿候选池（`activeOnly:false` 召回 active+draft）。
- **inc-2 ✅ 已 merge（#448 / YUK-398）**：`queryExistingPool`（`sourcing-sequence.ts`）已迁到 `poolFetch`，在算子之上重新 apply `kindsMatch` 过滤 + `compareBySourceTierThenWhitelist` tier 排序 + slice-after-sort（见 pool-fetch.ts 头部 INCREMENT-2 MIGRATION CONTRACT）。matcher 的「保守排序」§4 与这套 tier 排序需协调（复用同一比较器）。
- **discoverSupplyTargets / dispatcher（已 LIVE，`question_supply_nightly` 06:00 cron）** = matcher 的 drive 来源。matcher 建在这条 live 链上，不是唤醒 dormant 引擎（修正采集 spec §10「DORMANT」措辞，见 scoping note §7）。
- **`source_verify`/`quiz_verify`** = gate 的实现复用。caller 从「sourcing 链 eager」泛化为「caller-agnostic」（§3.3）。

## 7. 不变量 / A5 安全

- **answer_class 是验证轴**，matcher 用它做命中硬过滤，**不写 `judge_kind_override`、不动 judge routing**（`route-resolve.ts` profile 路由不受影响）。
- matcher **只读 `draft_status` 判别** active/draft，不引入来源 tag。
- **evidence-first**：gate 的三个 caller（尤其 owner override）留痕，promote 决策可追溯可回滚。
- **NULL embedding 降级**：matcher 退化为纯标量过滤（不崩，该行无语义召回）——继承采集 spec §4(d)。

## 8. 增量切分（TDD，每块独立可证可 merge）

| inc | 内容 | 状态 / 依赖 |
|---|---|---|
| 1 | `poolFetch` hybrid 检索算子 | ✅ #447 / YUK-396 merged |
| 2 | `queryExistingPool` 迁 `poolFetch`（等价 + 不回归，A2）| ✅ #448 / YUK-398 merged |
| 3 | **matcher 仲裁器核心**：retrieve → 保守排序 → branch on draft_status → use/verify-promote/generate | 本 spec 主体；gate = **薄派发调现有 `runSourceVerify`/`runQuizVerify`（b1，零改 handler）**，非合并抽取 |
| 4 | **owner manual gate path**（审核并启用 + override 留痕）| 本 spec 新增；UI = draft 池审核面 |
| 5 | forager + 廉价预筛（附加件）| Phase 1 后段 |
| — | answer_class 硬过滤开启 | gated on YUK-395 |

## 9. 开放问题（需 owner / 计划前定）

1. ~~命中阈值判据~~ → **owner 拍板复合**（§4，answer_class 硬 + 难度带软 + cosine 排序，阈值偏严）。
2. **算子作用域**：v1 单 KC（与 poolFetch 一致）；跨 KC/domain 池缓到后续（scoping note「算子作用域」）。
3. **queryText vs queryEmbedding 入参**（§3.1.5）：建议两者都收、`queryEmbedding` 优先。
4. **inc 顺序**：建议 inc-3 一上来 active+draft（`poolFetch` 已支持），draft 命中即触发 gate——gate 抽象一次到位。
5. **match latency**：lazy verify 在命中 draft 时引入一次 LLM verify 延迟。v1 接受；若实测卡 UX，再上 pre-warm job（§3.3）。
6. **owner manual path 的入口**：draft 池审核面是独立 route 还是挂在现有 admin/observability 面？（UI pre-flight 时定。）
