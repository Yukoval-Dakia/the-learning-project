# P2「typed 失败层」实现规划

> **For agentic workers:** 本 plan 由 P2 scoping workflow（w7txyqypq，4 组件并行 code-ground + synthesis）产出，已对 main 代码逐 seam 校验。实现前 owner 须先拍 §4 的 🔴 待决点（尤其 D2 A8 scope）。Phase A（capture 层）无 owner 决策依赖、data-independent，可立即动。

**Goal:** 把「答错」从一个 binary bit 升级成一条带类型的证据链：answer-class（题能怎么错）→ 错因/误解（错在哪个机制）→ 分步证据（哪一步错、错几次），喂进硬轨 θ/p(L)。

**Architecture:** 4 个 grounded 组件（YUK-367 attempt-payload / YUK-386 answer-class 轴 / A8 distractor→misconception / A9 step-grading 倍增器）是**一条数据流水线的不同段**，不是平行 feature。自底向上分 L0（capture，无依赖）→ L1（硬轨倍增器 + 检索 filter，gated B5）→ L2（typed-failure 消费 + misconception，owner 拍后才动）。

**Tech Stack:** TS-native（无 Python）；Drizzle/Postgres；ts-fsrs；flag-gated dark-ship（flag-off byte-identical）。

## Global Constraints

- **n=1 litmus**（裁判）：信号 admissible ⟺ 以 已知常数 / 充分统计量 / owner 供给固定先验 / 单学习者自身状态 进入；**绝不是跨被试方差分量（IRT a/c、CDM slip/guess、φ）**。
- **ADR-0035 红线**：软轨永不喂决策；A8/A9 证据进硬轨只能经 admissible 信号。
- **dark-ship 纪律**：任何触 live θ/selection 的增量 flag-off byte-identical（toBe 回归 anchor）。
- **两条硬 gate（贯穿全 P2）**：① B5 judge 校准（YUK-350，进行中）gates A9 喂 θ + A8 distractor-tag 信任；② ADR-0035 三轴正交 + B1 §3 可识别性矩阵 gates 所有软轨→硬轨方式。

## ⚠️ 校验过的承重 seam（synthesis 逐一 ground）

- `AttemptOnQuestion.payload` 无 choice 字段（`unsupported_judge` 是 additive 先例）— `src/core/schema/event/known.ts`
- `deriveAnswerClass` 纯结构分类器已落 main（INC-0 #446）— `src/core/schema/answer-class.ts`
- `updateThetaForAttempt(outcome: 0|1)` 单观测 — `src/server/mastery/state.ts`
- paper-submit `partial→1` 占位显式标「需扩 updateTheta 签名」（A9 deferred seam）— `src/capabilities/practice/server/paper-submit.ts`
- `composeJudgeResult` 把 N 个 `signal_verdicts` 塌成 1 个 score — A9 倍增器的 collapse seam

---

## ⭐ 重定性（2026-06-19，owner 设计 review 后）

**P2 不是「从零建 typed 失败层」，是「把已有的 cause 信号接进 profile + 守 n=1 红线」。** 设计 review 抓到：错因机制**早已 live**，A8 的「distractor→misconception」框架是文献 MCQ 思路、与 repo 不符。grounded 事实：

- **cause 归因 live**：`attribute.ts` 的 `runAttributionAndWriteJudgeEvent` = LLM 读 `wrong_answer_md`（文本）+ 题面 + 参考 + KC → 产出结构化 cause（`CauseSchema {primary_category, secondary_categories[], analysis_md}`），按 ADR-0006 写成 chained 在 attempt 上的 JudgeOnEvent。触发：followup job + copilot + import + paper-submit。
- **MCQ 天然统一进 judge-cause**：归因读文本，选择题的 chosen option text 就是 `wrong_answer_md` 的输入 → **选择题与开放题走同一条归因链，题型无关，不需要 distractor→misconception 表，也不需要 MCQ 专用路径**（ADR-0036:59 选 judge-cause 是对的）。
- **cause 存储 + taxonomy live**：`mistake_variant.cause_category` 列；cause 类目**按 SubjectProfile 声明**（audit:profile 校验）= n=1-admissible 的 owner-fixed 先验形态。
- **已有消费者**：`rating-advisor.ts` CC-1（cause → FSRS rating nudge，粗心类轻推）= **live**；`candidate-signals.ts:283` misconceptionRecurrence（按 cause_category 复发的选题信号）= **故意留 `undefined` 的 slot**（267-280：无 cheap reader，NEVER zero-fill）。

**因此**：A1（捕获 selected_choice_indices）**降级为可选 nice-to-have**（cause 归因已读得到选项文本，非 A8 硬前置）；A8 核心 = **填 misconceptionRecurrence slot**（per-KC cause 复发 tally，软选题信号）。distractor 表（旧 D1）不在主线。

**⚠️ misconception 图节点化（D4）是 owner 已 envision 的终局，非「可选」**：claude design 画的知识点详情页有「**指向此点的误区 · misconception**」section（误区实体 pointing at KC，「顽固的错误信念」= ADR-0036 RT1 节点 + misconception_edge）+「反向链接 · 按来源类型」（dual-layer KG）。tally（D2）与 RT1 节点（D4）是**一条晋升链**：cause 复发 tally = 上游证据 → 复发 ≥k → 晋升成 RT1 节点 → 渲染成该 section；UI 画终局，plan 自底向上建，晋升前 section 显示空态（截图现状）。**D4 排在 tally 之后、gated 一致性闸（ADR-0034），但确定要建。** 同理 P1 的 θ/p(L)/difficulty + 校准成熟度也有 UI 家（该页上半「成长 ladder + 硬轨校准·低置信 badge」）。

---

## 1. 依赖序

```
P1(已落): 结构轴 · poolFetch · embedding · B1 三轴(YUK-348 Done) · θ̂/p(L)(YUK-361)
   │
   ├─ YUK-386 answer-class 轴 (INC-0 已落 #446; ⚠ deriveAnswerClass 是第4份并行copy=漂移面+1)
   ├─ YUK-367 attempt-payload (纯 capture, Inc1-3 无依赖)  ──chosen-distractor 是 A8 判别证据──┐
   └─ A9 step-grading 倍增器 (机器已存在, 塌在写θ前; 需扩 updateTheta 签名)                      │
                                                                                          ▼
   answer-class 决定「哪些 failure type 可能」──框架链接──► A8 distractor→misconception
                                                          (无 Linear 号, 设计矛盾待拍 D2)
                                                              │ (晋升路线才需)
                                                              ▼
                                                   RT1 misconception 节点(ADR-0036)
                                                   GATED: ADR-0034 一致性闸 + FK_ORDER + H7
```

**build order**：L0（无依赖，立即可动）= YUK-367 capture + YUK-386 INC-1 freshness。L1（依赖 L0 + B5）= A9 倍增器 + answer-class matcher hard-filter。L2（依赖 owner 拍设计 + RT1 闸）= A8 推理链 / misconception 晋升。

---

## 2. 分阶实现 plan

### 阶段 A — 数据 capture（L0，无依赖，立即可动）

| # | 组件 | builds | schema/data | dark-ship? | key files | TDD anchor | depends-on |
|---|------|--------|-------------|-----------|-----------|-----------|-----------|
| **A1** | YUK-367 | `AttemptOnQuestion.payload` 加 additive optional `structured_evidence`（discriminated by kind；choice→`{selected_choice_indices, choice_count}`）。无 reader/writer。 | **无 DDL**（jsonb，Zod 改） | N/A（无 live path） | `src/core/schema/event/known.ts` | Zod parse-compat：历史 attempt（无新字段）仍 parse 成功（沿用 `unsupported_judge` 纪律） | 无 |
| **A2** | YUK-367 | submit 把结构化 choice 从 UI 透到 wire：继续发 `answer_md`（grading 不变）+ 额外发 `selected_choice_indices`，写进 A1 字段。4 条 path。 | 无 DDL | ✅ flag `CAPTURE_STRUCTURED_CHOICE`，write-only dark data | `practice-choice-logic.ts`+`PracticeChoiceOptions.tsx`；`practice/api/submit.ts`、`paper-submit-route.ts`、`solve-submit.ts`、`notes/api/embedded-check-attempt.ts` | 单测：4 path 提交后 payload 含 indices；`answer_md` 仍 option text（grading byte-identical） | A1 |
| **A3** ⭐ | YUK-386 INC-1 | **answer-class on-write freshness（YUK-395，硬解锁器）**：13 个 `insert(question)` 站点 + editQuestion 调 `deriveAnswerClass`。helper `withAnswerClass(values)`。 | 无新列（`answer_class` 已存在，今 NULL）；additive write path | ✅ 写侧填 NULL 严格安全，无需 flag | 13 insert 站点 + editQuestion | DB 测：新 insert 立即非 NULL；editQuestion 改 kind/choices/rubric 后 re-derive 而非 stale | 无（INC-0 已落） |
| **A4** | YUK-367 | read projection：`getFailureAttemptById` + `get-attempt-context` tool 输出 surface indices。 | 无 | N/A | `src/server/events/queries.ts`、`src/server/ai/tools/get-attempt-context.ts` | 单测：captured choice 出现在投影 + tool 输出 | A1, A2 |

### 阶段 B — 硬轨倍增器 + 检索 filter（L1）

| # | 组件 | builds | dark-ship? | depends-on |
|---|------|--------|-----------|-----------|
| **B1** | A9 | 纯函数：`JudgeResultV2`(`steps_v1_weighted`) 的 `signal_verdicts` → N 个 binary per-step 观测（FIXED partial-binarize）。无 wiring。 | ✅ flag `STEP_GRADING_EVIDENCE_ENABLED=false` | A 阶段 |
| **B2** | A9 | caller wiring at collapse seam：flag ON + judge ran steps + B5-calibrated → 单次 `updateThetaForAttempt` 换 N 次喂 per-step 观测（**FLAT multiplier，零 schema**）。FSRS rating 仍 1/attempt。消 `partial→1` 占位。 | ✅ flag-off→今天单 binary | B1, B3, YUK-361 |
| **B3** | A9 | B5/judge 校准 gate 具体化：成熟度检查决定 step-观测进 θ（硬 gate）还是扣留→owner review。 | flag-coupled | YUK-350(B5) |
| **B4** | YUK-386 INC-2 | matcher answer_class hard-filter：`Demand.answerClass` 接进 `pool-fetch.ts` WHERE，替/增 legacy `kindsMatch`。 | ✅ flag `MATCHER_ANSWER_CLASS_FILTER` | A3 |

### 阶段 C — 漂移收口 + vocab 清理（L1，行为保持，可并行）

| # | 组件 | builds | depends-on |
|---|------|--------|-----------|
| **C1** | YUK-391 INC-3 | twin 收敛：`route-resolve`+`judge-routing`+`verify-framework.isExactQuestion` 委托 `deriveAnswerClass` 结构核。**先 byte-equality snapshot 矩阵，再 refactor，再独立 Opus reviewer 过 A5 路由等价。** | INC-0 |
| **C2** | YUK-390 | 脏 kind 列清理：profile-vocab→canonical backfill-then-tighten + 收紧 3 fixture schema。 | C1 |
| **C3** | YUK-392 | 生成端收口：`quiz_gen`+`sourcing` kindsMatch reject + 4 个硬编码 8-value prompt 串收口。 | C2 |

### 阶段 D — A8 消费已有 cause（L1，重定性后大幅变轻）

| # | 组件 | builds | dark-ship? | depends-on |
|---|------|--------|-----------|-----------|
| **D0** | 全 P2 | commit 缺失 SOT 导航 doc 进 repo（决策已拍，无需 spike）。 | — | 无 |
| **D2 ⭐** | A8 核心 | **填 `candidate-signals.ts:283` misconceptionRecurrence slot**：建「候选题→错因家族（cause_category 维）跨 attempt 复发频次」聚合查询 → 软选题信号（MFI nudge）。**绝不进 `updateThetaForAttempt`（n=1 红线）。** | undefined→MFI-only 退化保持；填后仅加软 nudge | cause 数据累积（query 可现在建，信号随数据变浓） |
| **D-conj** | A8 | （可选）surface「哪些 cause 还 open」给 conjecture engine（教研团 Phase 0, YUK-406）读。 | 纯 read | D2 |

### 阶段 D' — 可选 / gated（owner 明确要才动）

| # | 组件 | builds | gated-on |
|---|------|--------|----------|
| **A1** | YUK-367 | （可选）`structured_evidence` capture + selected_choice_indices——确定性 tally / 未来 distractor tagging 用。**非 A8 硬前置**（cause 归因已读选项文本）。 | owner 要确定性 tally/tagging |
| **D4** | A8 | misconception **图节点化**（owner 已 envision，UI 终局——见详情页「指向此点的误区」section）：RT1 `misconception` 节点 + `misconception_edge` + 晋升路线（cause 复发 tally ≥k → propose → human-accept）。**确定要建，排在 D2 tally 之后。** | ADR-0034 一致性闸 + FK_ORDER lockstep + H7 同一性判据（owner 未拍）|
| **D5** | A9 INC-4/5 | 自一致性方差→PPI 权重（**绝不当 θ slope**）；per-step KC routing（仅 owner 选 per-step）。 | A12(YUK-439) PPI, B2 |

---

## 3. schema 变更汇总

**净 DDL 增量（最小路线 = FLAT multiplier + payload capture + RT1 不走晋升）= 仅 `question_distractor_tag` 1 表（A8 D1 必需）。** 其余全是 payload subfield（Zod）/逻辑/已落列（`answer_class` migration 0041 已落、已 PASS audit:schema）。RT1 `misconception`+`misconception_edge`（2 表）、`learner_misconception_state`、`expected_signals` 扩展 都 gated 在 D4/D5（owner 选晋升/per-step 路线才需），均需 allowlist + 结构天花板注。

---

## 4. 🔑 待决设计点（owner 必须先拍）

> 诚实结论：捕获层（阶段 A）几乎全确定且 admissible，可立即动。真正未决的是**消费层形状**——尤其 A8 scope 在 repo↔文档**互相矛盾**，answer-class→failure-type 映射**零 artifact**。

### 🔴 D0 — 缺失 SOT 文档（阻塞下游设计）
两份核心 design doc 在 repo 不存在（git log 空），只 Linear mirror。**动作**：commit Linear mirror 为 checked-in SOT（audit-drift/audit gate 需要），A8/A9 实现前必须落。

### ✅ D2 — RESOLVED（owner 拍定 2026-06-19）
**judge-cause 路线，复用现有 `cause_category`，不建 distractor 表，A1 降级为可选。** cause 归因（`attribute.ts`）已 live 且 answer-text-based，MCQ 与开放题天然统一进同一条链（见重定性段）。A8 核心 = 填 `candidate-signals.ts:283` 的 misconceptionRecurrence slot（per-KC cause 复发 tally，软选题信号）。distractor→misconception 框架（文献 MCQ 思路）废弃。

### ✅ D3 — DISSOLVED（owner 拍定 2026-06-19）
**不新建 failure-type taxonomy / ADR。** 既有 `cause_category`（SubjectProfile 声明、owner-curated）**就是** typed-failure 的语义轴；answer_class 是**正交的结构/路由轴**（题能怎么答），二者不重叠。「哪些 failure-type 可能取决于 answer-class」是**软先验**，cause-attribution LLM 已隐式处理（不会给 exact 题归因 missing_step，因题面/答案无步骤）——不值得编成硬 schema。`VerifyFailureClass`（verify 侧）保持原样，不动。

### 🟠 其余（形状细节，建议见 brief）
- **D1** attempt-payload 字段形：建议 **capture-only**（最小 v0），用 generic `structured_evidence`（discriminated by kind）留扩展位。
- **D5** A9 multiplier：建议 **FLAT 先行**（N 步全 credit 题 KC set，零 schema），per-step KC routing 后置。
- **D5b** partial 步 binarize：建议 **partial→FIXED 0.5 via `conjunctiveCreditsContinuous`**（endpoint-safe，已用）。**红线**：FIXED 映射，不是 fit per-step partial-credit 曲线（= GPCM n=1 陷阱）。
- **D5c** 自一致性方差：建议 inc-1 单 run，多 run+方差→PPI 权重后置 D5。**方差只当 label-reliability，绝不当 θ slope。**
- **D-twin** YUK-391 收敛时机：建议**暂缓到有真 reader**（当前无 reader 把 answer_class 当权威，收敛纯技术债 + A5 回归风险）。
- **D-fresh** freshness 机制：建议 **inline-at-insert + re-derive-on-edit hook**。
- **D-auth** answer_class 是否升 NOT NULL+CHECK：建议**保持 derived cache（NULL-fallback）**，gated on 全 backfill。

---

## 5. n=1 / ADR-0035 红线检查

每个组件**核心捕获/倍增机制都 admissible**：chosen-distractor capture（单学习者自身状态）✅；answer-class（item-intrinsic 纯函数）✅；A9 per-step binary（自身状态 + b_step 是 owner-anchored prior，N 观测=充分统计量扩展非 discrimination）✅；A8 per-KC misconception tally（self-state 计数）✅；distractor→misconception MAP（owner-fixed prior/curated annotation）✅**仅当作 prior**。

**三个 at-risk param 全在消费层，code 须落成断言**：
1. 🚨 A9 LLM 自一致性方差**绝不当 per-item θ slope**（slope=a 参数=跨被试方差=INADMISSIBLE）；只当 label-reliability 权重/纳入门。
2. 🚨 A8「distractor 诊断力 / P(misconception|chosen)」**从 response pattern 估计=跨被试方差量（CDM slip/guess + IRT a/c 化身）=INADMISSIBLE**；必须软轨低置信，绝不喂 θ/p(L)/调度。
3. 🚨 A8 misconception tag **只能偏置选哪道题（软轨 MFI nudge）**，misconception-weighted θ update 走私跨被试结构 = INADMISSIBLE。

---

## 6. 建议起点（重定性后）

设计 fork 全拍定（D2 RESOLVED / D3 DISSOLVED / D0 = commit doc），三个 data-independent 增量可立即起，无任何剩余 owner 待决：

1. **D0**：commit 两份 SOT 导航 doc 进 repo（补 repo-as-source，audit gate 需要）。最轻，先做。
2. **A3 ⭐**（YUK-395 answer-class on-write freshness）：硬解锁器（`answer_class` 列已落但 13 insert 站点全不 set→新 question 一律 NULL，B4 matcher hard-filter 硬阻塞在它），写侧填 NULL 严格安全。
3. **D2 ⭐**（A8 核心，填 misconceptionRecurrence slot）：建 per-KC cause 复发聚合查询 → 软选题信号。query 现在就能建（admissible，软轨），信号随 cause 数据累积变浓。

**不要先动**：A9 喂 θ（硬 gate 在 B5/YUK-350）；A1 distractor capture（降级可选，非 A8 前置）；RT1 图节点化（owner 未要）；twin 收敛 C1（无 reader 需要 + A5 回归风险）。

## Linear 跟进闸

建议 owner 在 P2 epic（YUK-203 family）下登记：(1) **D0 缺失 SOT doc commit**（新 actionable，YUK-367/386/A8/A9 共同上游）；(2) **answer-class→failure-type taxonomy ADR**（新开）；(3) A8 无 Linear 号——若走 §4 D2 建议路线应新建对应 issue。其余（YUK-367/386/390/391/392/395/438/350）已有号。
