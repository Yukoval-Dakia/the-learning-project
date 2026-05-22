# Foundation 真 Closeout (Physics + Partial→FSRS) Design

**Status**: design spec for v0.3 Foundation A/B/C 真 closeout（结构件之外的 generalization acid test）。
**Date**: 2026-05-22.
**Scope**: 把 physics 作为 subject #3 pressure subject，验证 Foundation 抽象在 N=3 下仍泛化；把 judge → FSRS 的 partial credit 链路真接通，让 `JudgeResultV2.score` 不止流到 UI。
**Anchor decisions**: [ADR-0014 — Generalized Learning Activity + Capability Registry](../../adr/0014-generalized-activity-and-capability-registry.md)（特别是 §3 SubjectProfile / §4 JudgeResult v2 / §10 FSRS 是 scheduling policy 之一），[v0.3 roadmap](../../planning/v0.3-generalized-ai-learning-framework.md) §1.5 Foundation 段。
**Predecessor**: math MVP（[2026-05-21-math-mvp-vision-design.md](2026-05-21-math-mvp-vision-design.md) 已 ship 全 phase）；本 spec 是其延续，专攻 math MVP closeout doc §"What math MVP 没证" 列出的两块（subject 泛化 N=3、partial credit 下游）。
**Non-scope**: subject #4（programming / english）；physics 图像/示意图题（M2 复用 math figures 字段即可，本期不专攻多模态）；partial → mastery view / next-due 算法调优（ADR-0012 后续）；跨科目题；ts-fsrs 内核改动；correction event production 负载压测；Option B/C partial→FSRS 激进方案（Option A 真实使用后再决定）。

## 1. Goal

让以下 4 条断言**通过真实运行被验证**，把 Foundation 从"结构件 ready"升级到"经得起 N=3 + score 真贯穿"：

1. **加 subject = profile 数据 + 0 行框架 diff**（acid test of Foundation B 真泛化）—— physics profile 落地后，`git diff main -- src/core src/server/ai src/server/review src/ui app/api` 框架层应当为空（profile 增量、subject-private 代码、fixtures 不算框架）。
2. **加 judge route = manifest 注册 + 0 行 registry/router 接口 diff**（acid test of Foundation A 真泛化）—— `unit_dimension@1` 落地后，`src/core/capability/registry.ts` + `src/server/ai/judges/index.ts` LOC 应当不变（仅 `src/core/capability/judges/index.ts` 的 register 调用增加一行）。
3. **JudgeResultV2.score 真进 FSRS 调度链路**（acid test of Foundation C 真贯穿）—— partial 题不再被 UI 强制走 again / good 二元，judge 给出 rating advisory，UI 显示并默认采纳，用户仍可改。
4. **physics + math + wenyan 三科目并存不退化**：现有 wenyan / math 复习闭环 regression 通过；三科目 cause categories / promptFragments / renderConfig 互不污染。

不在本 spec 范围内的事情靠后续 phase 完成；本 spec 收口的是上面 4 条断言能成立的最小切片。

## 2. Drivers / 选型记录

### 2.1 Physics 作为 Subject #3（而非 programming / english）

| 科目 | 对 Foundation 的压力点 | 风险 |
|---|---|---|
| programming | renderConfig.codeHighlight / sandbox / 无答案唯一性 / 远端 runtime | 切片巨大（sandbox 是独立 Foundation 工作），N+2 才合适 |
| english | 语言学习，profile 重叠 wenyan 多 | acid test 强度低，无法暴露假设 |
| **physics** | **renderConfig.notation=latex（与 math 重叠）+ 单位/量纲（unit_dimension@1 新 judge route）+ 推导（复用 steps@1）** | 切片可控，对 Foundation A 与 Foundation C 的压力比 math MVP 更大 |

Physics 的关键 acid test：单位 / 量纲是 wenyan / math 都不存在的判分维度，逼迫 capability registry 接受真正"第 3 类" judge route（前两类 exact/keyword/semantic 是 "match 文字"，steps 是 "match 推导"，unit_dimension 是 "match 物理意义"）。如果 capability 抽象在 unit_dimension 上要改 registry / runner 接口，说明 Foundation A 还藏了 wenyan/math 假设。

### 2.2 Subject #3 与 partial→FSRS 一起做（而非分两份 spec）

二者是同一根问题的两面 ——"Foundation 抽象到底有没有真泛化"：

- **subject #3** 验证**横向**泛化（profile / capability / renderConfig 对 N=3 不退化）
- **partial→FSRS** 验证**纵向**泛化（JudgeResultV2 的 score 信号真贯穿到调度层）

分开做容易出现"subject 加完了，但 score 还是装饰" / "score 接通了，但只有 math/wenyan 跑得通" 的半成品。合并 spec + 拆 sub-phase plan，是 math MVP 已验证的 spec 形态。

### 2.3 partial→FSRS 选 Option A（rating advisory）而非 Option B（绕过 4 档）

考虑了 3 种映射方案：

| 方案 | 实质 | 优势 | 劣势 |
|---|---|---|---|
| **A. Rating advisory** | judge.score → 推荐 FsrsRating（4 档），UI 默认选中推荐档，用户可改 | 不动 FSRS 内核 / 保留人类 in the loop / 改动小 | 仍 4 档离散，score 连续信息部分丢 |
| B. Score 直接进 FSRS | 改 ts-fsrs wrapper，0..1 → 连续 grade | 信息无损 | ts-fsrs 接口不支持连续 grade，要 fork 或重实现 |
| C. 4 档 + score 修正 stability | 主 rating 4 档，partial 时按 score 给 stability * (0.5 + 0.5 * score) | 折中 | 在 FSRS 外加层 hack，难以审计 |

Option A 是 MVP 选择，对应 ADR-0014 §10 "FSRS 是 scheduling policy 之一" —— 调度政策由 judge 信号驱动，但保留人类信号 override；不动 FSRS 内核，未来 Option B/C 仍开放。

### 2.4 `unit_dimension@1` 作为 capability 而非 utility

走 capability 不走 utility 函数的理由：

- judge route 需要被 profile.judgeCapabilities 声明 → profile validator 自然 enforce
- evidence 留痕需要 capabilityRef（"由 unit_dimension@1 判分"）—— utility 函数没这个语义位
- 未来如果引入 unit_dimension@2（更激进的量纲推导）—— capability 的 manifest.version 字段已经为此设计

### 2.5 Phase 拆分参考 math MVP 节奏

Math MVP 的 7 phase 拆分（M-1/M0/M1/M2.1/M2.2/M2.3/M3）实证有效：每 phase 1-3 天，独立 PR，独立 reviewer 关卡，独立 audit。本 spec 沿用同节奏，但因 physics 引入 capability 路径已被 math 跑过、不需要 capability skeleton 走 1 整 phase，phase 数量可压到 6 个（P-1/P0/P1/P2/P3/P4）。

## 3. Phase 序列

总投入估计 **10-15 个工作 day**，可在 2-3 周内推完。每 phase 显式 exit criterion，不达则回退 / 拆 phase。

### Phase P-1 — Preflight + 现状审计 + framework diff baseline — 1 day

**Goal**: 列 partial credit 各层现状 cheat sheet；建 framework diff baseline；physics fixture 10 道（含单位/量纲样本）落地，不引 profile / capability。

**Scope**:
1. **现状 audit doc**（写到 `docs/audit/2026-05-2X-partial-credit-trace.md`）：列 `JudgeResultV2.score` / `coarse_outcome` 在 judge → DB event → review UI → review submit → FSRS 各层的当前流向，标出"断点"（已确认主断点在 review submit 把 `rating` 当唯一输入）。
2. **Framework diff baseline**（写到同一 audit doc 末尾）：snapshot 当前 main 在以下文件 / 目录的 LOC，作为后续 phase "framework diff = 0" 的 baseline：
   - `src/core/capability/`（registry / types / validate-profile / judges/{exact,keyword,semantic,steps}）
   - `src/core/schema/{activity,capability,event/**}.ts`
   - `src/server/ai/judges/{index,question-contract,router,steps-judge,...}.ts`
   - `src/server/review/{fsrs.ts,activity-ref.ts,...}`
   - `src/ui/lib/subject.ts` / `math-markdown.tsx`
   - `src/subjects/profile.ts`（base layer，不含 wenyan/math/physics 子目录）
   - `app/api/review/{submit,plan,due,appeal}/route.ts`
3. **Physics fixture seed**（10 道，未接 profile）：5 道单位换算 + 3 道量纲分析 + 2 道公式应用；seed 到 `src/subjects/physics/fixtures/data.json`；不动 schema，不引 profile，纯数据。Fixture metadata 包含 expected `unit_dimension` 判分关键点（缺单位 / 单位错 / 量纲不平 / 数值错 4 类），方便 P2 写测试。

**Exit criterion**:
- Partial credit trace audit doc merged 到 main
- Framework diff baseline 写入 audit doc（包含 `git ls-tree` 的 LOC snapshot 引用）
- 10 道 physics fixture json 落地（schema validation 通过，但不接 profile / registry）
- 现有 wenyan + math regression 通过

### Phase P0 — Physics profile + Foundation B acid test — 2-3 day

**Goal**: physics SubjectProfile 落地、SubjectRegistry 注册、端到端跑通 physics choice + fill_blank；**framework diff = 0 行**（acid test 1）。

**Scope**:
1. `src/subjects/physics/profile.ts` 最小 profile（详 §5；P0 起步 `questionKinds: ['choice', 'fill_blank']` + `judgeCapabilities: ['exact', 'semantic']`；不引 unit_dimension）
2. `src/subjects/profile.ts:100-101` 增 `this.register(physicsProfile)`；`DEFAULT_ALIASES` 加 `physics` / `physical`
3. profile validator 跑过（renderConfig.notation='latex' + 声明 capability 真在 registry）
4. P-1 落地的 10 道 fixture 走 ingestion → question 入库 → review 队列；choice + fill_blank 都能 judge
5. **Framework diff verification（acid test 1）**：
   - `git diff main -- src/core src/server/ai src/server/review src/ui app/api`（subject 子目录除外）应当为空
   - 如果非空，phase **回退** 并把 diff 原因写入 spec deltas 文档；继续之前需 user 确认是否调整 spec / 接受 framework diff
6. Wenyan + math regression 通过（fixture 跑一遍）

**Exit criterion**:
- Physics 10 道 fixture 走完闭环（学习 → 答题 → judge → review 队列）
- `git diff main -- <framework paths>` 为空（acid test 1 通过）
- profile validator 通过
- wenyan + math fixture regression 通过

### Phase P1 — `unit_dimension@1` capability skeleton + Foundation A acid test — 1-2 day

**Goal**: `unit_dimension@1` 落 manifest + skeleton runner（return unsupported）+ 注册到 createDefaultRegistry；physics profile.judgeCapabilities += 'unit_dimension'；judge router 解析到 'unit_dimension' route 返 unsupported；**registry/router 接口 0 行 diff**（acid test 2）。

**Scope**:
1. `src/core/capability/judges/unit_dimension.ts` —— manifest（kind='judge', version=1, cost='local', latency='sync'）+ skeleton runner（return `{ coarse_outcome: 'unsupported', capabilityRef: { ... } }`）
2. `src/core/capability/judges/index.ts` —— 增 `registry.registerJudge(unitDimensionV1Capability)`（**唯一允许的 framework diff**）
3. `src/core/schema/capability.ts` —— ScoreMeaning enum 增 `'unit_dimension_v1'`（P2 用）
4. `src/subjects/physics/profile.ts` —— judgeCapabilities += 'unit_dimension'；`judgePolicy.preferredRoutes` 加 'unit_dimension'
5. `src/server/ai/judges/question-contract.ts` —— `resolveQuestionJudgeRoute` 加分支：physics + question.kind ∈ {'calculation', 'short_answer'} → 'unit_dimension'（仅这一行 framework diff，需 spec deltas 文档记录）
6. **Framework diff verification（acid test 2）**：
   - `src/core/capability/registry.ts` LOC change = 0
   - `src/server/ai/judges/index.ts`（JudgeRouter 主体）LOC change = 0
   - 允许 diff：`src/core/capability/judges/index.ts` + 1 行（registerJudge 调用）；`src/core/schema/capability.ts` enum 增项；`src/server/ai/judges/question-contract.ts` route 分支
7. Test：unit_dimension skeleton 路由 + unsupported 返回；physics fixture 现在路由到 unit_dimension（但仍 unsupported，期望行为）

**Exit criterion**:
- `unit_dimension@1` 注册到 registry，能被 route resolver 命中
- Acid test 2 通过（registry.ts + router 主体 0 行 diff）
- Profile validator 通过（physics 声明的 capability 真在 registry）

### Phase P2 — `unit_dimension@1` impl — 3-4 day

**Goal**: deterministic accelerator + LLM fallback + score 合成；4 类错误路径都能正确分类。

**Scope**:
1. **Deterministic accelerator**: 用 mathjs 的 unit lib（已在依赖中？P-1 verify）做单位 normalization 与量纲分析
   - 输入：学生答案文本 + reference unit + reference value
   - 输出：`{ value_match: bool, unit_match: bool, dimension_match: bool, normalized_value: number, normalized_unit: string }`
2. **LLM fallback** (用 mimo-v2.5)：accelerator 给不出 normalized form 时（如学生写"30 km/h"但 reference 是"米/秒"），调用 LLM 做单位换算 + 量纲对齐
   - structured output: `{ student_value_si: number, student_unit_si: string, equivalent_to_reference: bool, dimension_mismatch_reason?: string }`
3. **Score 合成**: 4 类错误路径明确分数：
   - 单位 + 数值都对：score=1.0, coarse_outcome='correct'
   - 单位对、数值错（误差 < 5%）：score=0.7, coarse_outcome='partial', signal='numeric_close'
   - 单位对、数值错（误差 ≥ 5%）：score=0.3, coarse_outcome='incorrect', signal='numeric_off'
   - 单位错、量纲对（如 km vs m）：score=0.4, coarse_outcome='partial', signal='unit_mismatch_same_dimension'
   - 量纲错（如 km/h vs km）：score=0.0, coarse_outcome='incorrect', signal='dimension_mismatch'
   - 完全错（含 unsupported 输入）：score=0.0, coarse_outcome='incorrect' or 'unsupported'
4. Test：10 道 physics fixture 跑通；4 类错误路径每类至少 1 道 fixture 命中

**Exit criterion**:
- 10 道 physics fixture 答对 / 单位错 / 量纲错 / 数值错 4 类分别能正确路由 + 正确 coarse_outcome + score 合成正确
- `unit_dimension@1` 调用 LLM fallback 的样本路径有测试覆盖（mock LLM）
- 现有 wenyan + math regression 通过
- 框架代码 LOC change = 0（不在 unit_dimension.ts / physics 子目录之外）

### Phase P3 — partial → FSRS rating advisory + Foundation C acid test — 2-3 day

**Goal**: judge.score → FsrsRating 推荐映射；review UI 默认采纳推荐档，用户可改；review submit 路径 `rating` 仍由 body 决定（不动 FSRS 内核 ABI）；partial 题不再被强制走 again / good 二元。**关键：score 信号从 judge 真贯穿到 FSRS 调度** （acid test 3）。

**Scope**:
1. **Advisory 函数** `src/server/review/rating-advisor.ts`（新文件）—— 纯函数 `judgeResultToRatingAdvice(result: JudgeResultV2T): { rating: FsrsRating, reason: string }`：
   - coarse_outcome='correct' + score ≥ 0.9 → easy
   - coarse_outcome='correct' + score ≥ 0.7 → good
   - coarse_outcome='partial' + score ≥ 0.5 → hard
   - coarse_outcome='partial' + score < 0.5 → again
   - coarse_outcome='incorrect' → again
   - coarse_outcome='unsupported' → null（advisory 不可用，UI 落到无推荐状态）
   - reason 是人类可读："steps@1 给 partial credit 0.6，推荐 hard"
2. **Review submit route** `app/api/review/submit/route.ts`：
   - 新增 optional 字段 `judge_result_v2: JudgeResultV2.optional()`（UI 提交时把 judge 结果带回来，供 event payload 留痕）
   - **不改** `body.rating` 是必填的 ABI —— Option A 不绕过 4 档
   - event payload 增 `judge_advice?: { rating, reason }`（如果 UI 提交，留痕方便后续分析"推荐 vs 用户实际选"差距）
3. **Review UI** `app/(app)/review/page.tsx`（subject-agnostic 路径，不在 framework / 也不在 subject 子目录 —— 接受 1 行 diff）：
   - 答题后展示 advisory：`<RatingAdvisor advice={...} />` 显示推荐档 + reason
   - 4 档按钮默认 highlight 推荐档
   - 用户点击其他档则覆盖推荐 —— 提交时仍发用户实际选的 rating
4. **Test**：
   - rating-advisor.ts 单测覆盖 6 个分支
   - submit route test 加 case：传 judge_result_v2 → event payload 含 judge_advice
   - UI test 加 case：partial 题展示 advisory；用户改档 → 提交的 rating 是用户选的不是推荐的
5. **Acid test 3 verification**：
   - 一道 physics partial（score=0.6）题走完路径：judge → advisory='hard' → UI 默认 highlight hard → 用户点 submit → DB event payload 含 judge_advice='hard' + 用户 rating='hard' → FSRS state 按 hard 更新
   - 一道 math partial（同上路径）—— 跨科目 advisory 行为一致
   - 一道 wenyan correct（advisory='good'）regression —— 老 wenyan 流不退化

**Exit criterion**:
- `judgeResultToRatingAdvice` 6 分支全测过
- Physics + math partial 题在 review UI 显示 advisory 并默认 highlight 推荐档
- Submit event payload 含 judge_advice（partial 题 100% 覆盖）
- Wenyan correct 题 regression 通过（advisory 显示 good，行为不变）
- 框架 diff = `rating-advisor.ts` 新文件 + review submit 增 1 字段 + review UI 增 advisory 组件；FSRS 内核 / activity-ref / scheduleReview ABI 0 行 diff

### Phase P4 — Closeout audit + framework diff verification + spec deltas 收口 — 1-2 day

**Goal**: 跑 /audit-drift；验证 framework diff 与 P-1 baseline 对齐；写 Foundation 真 closeout audit doc；status.md 把 🟡 升 ✅ 或显式标注"closed @ <date>"。

**Scope**:
1. 跑 `/audit-drift`，产生 `docs/audit/2026-05-2X-foundation-true-closeout.md`
   - Aligned / Documented-only / Undocumented / Contradicted / Phase-deferred 各项点验
   - **必须有的核验**：physics profile 加完后 framework 文件 LOC change（与 P-1 baseline 对比）、rating-advisor 加完后 FSRS 内核 ABI 不变
2. status.md §1 Foundation A/B/C 表格 🟡 → ✅ + 加一行 "Foundation gate formally closed @ 2026-05-2X (verified by physics + partial→FSRS acid tests)"
3. v0.3 planning doc §1.5 Foundation A/B/C 段加状态收口段落
4. Spec deltas 文档（如果 P0/P1/P2/P3 中有任何 framework diff 超出预期）补完
5. 列 N+1 follow-ups（仿 math MVP closeout）：
   - Option B/C partial→FSRS 评估
   - subject #4（programming / english）路径上是否还有藏的假设
   - unit_dimension LLM fallback 评估（用量大不大 / 命中率 / 是否需要 deterministic-only 模式）
   - rating advisory 接受率分析（多少用户接受 vs 改档；改档原因聚类）

**Exit criterion**:
- `/audit-drift` 0 new finding（physics + partial→FSRS 引入的所有决策都在 spec + ADR 体系内）
- Framework diff 与 P-1 baseline 对齐（acid tests 1/2/3 全过的事实有 audit 留痕）
- status.md / v0.3 doc 状态更新
- N+1 follow-ups 入 closeout doc

## 4. 现状 verify 记录

为后续 Agent / 人能查"为什么 P3 必须接通"，把 2026-05-22 verify 结果固化：

### 4.1 Partial credit 各层现状

| 层 | 现在消费什么 | partial 信号有没有进来 |
|---|---|---|
| Judge (`judgeAnswer`) | 算出 `JudgeResultV2 { score, coarse_outcome, capabilityRef }` | ✅ 算出来了 |
| Event log | event.payload.judge 含 score + coarse_outcome | ✅ 留痕完整 |
| Review UI 显示 | `JudgeResultPanel` 显示 score + capability label + appeal 按钮 | ✅ 显示给用户看 |
| Review submit route | `body.rating: FsrsRating` —— UI 4 按钮点击 | ❌ **rating 由用户手点，judge.score 不参与映射** |
| `outcome` 推断 | `body.rating === 'again' ? 'failure' : 'success'`（route.ts:88） | ❌ **二元，partial 信号丢** |
| FSRS scheduler | `scheduleReview(prevState, body.rating, now)` | ❌ **接收 rating 不接收 score** |
| Mastery view | 读 event.payload.outcome（二元） | ❌ **partial 不进 mastery 计算** |

**结论**：判分→留痕→显示链路通；判分→调度链路在 review submit 那里断了。P3 修这一段；mastery view 这一段（partial → mastery）是 N+1。

### 4.2 ts-fsrs 接口现状

- `Rating` enum: Again=1 / Hard=2 / Good=3 / Easy=4（离散 4 档）
- `scheduler.next(card, now, rating)` —— grade 是 enum，不接受 0..1 float
- Option B（绕过 4 档）需要 fork ts-fsrs 或自写 wrapper，本期不做

### 4.3 Subject scaffolding 现状

- `SubjectRegistry` 现注册 wenyan + math（`src/subjects/profile.ts:100-101`）
- DEFAULT_ALIASES 含 wenyan / math 系列别名
- 加 physics = register 一行 + alias 几行 + 子目录建 profile.ts —— **本身就是 Foundation 设计预期**
- Acid test 1 要 enforce 的：除上面这些，框架其他文件 LOC change = 0

## 5. Physics SubjectProfile 形态

```ts
// src/subjects/physics/profile.ts
import type { SubjectProfile } from '../profile';

export const physicsProfile: SubjectProfile = {
  id: 'physics',
  version: '1.0.0',
  displayName: '物理',
  languageStyle: '中文讲解，强调物理量定义、单位与量纲、推导链路。',
  questionKinds: [
    'single_choice',
    'multiple_choice',
    'short_answer',
    'calculation',
    'derivation',
  ],
  judgePolicy: {
    // P0 起步：'exact', 'semantic'；P1 起增 'unit_dimension'；P2 起 'steps' 复用 math
    preferredRoutes: ['exact', 'semantic'],
    notes: [
      '数值题优先 unit_dimension（P1+）。',
      '推导题复用 steps@1（与 math 共享 capability，不重写）。',
      '公式选择题走 exact / semantic。',
    ],
  },
  exampleSources: ['题面条件', '物理定律', '推导公式', '学生计算步骤'],
  noteTemplate: {
    definition: '写清物理量定义、单位、矢量/标量属性、适用条件。',
    mechanism: '拆解所用物理定律、推导链路、量纲一致性检查。',
    example: '给出带单位的完整推导例题，保留中间量纲。',
    pitfall: '列出易错单位换算、矢量方向、适用条件遗漏、量纲错位。',
    check: '给出一个量纲检查或单位换算小题。',
  },
  grounding: {
    requirement: '推导必须能追溯到物理定律、定义、量纲分析或题面条件。',
    allowedSources: ['user_material', 'textbook', 'formula_sheet', 'llm_prior'],
    uncertaintyPolicy: '条件不足时指出缺少的条件，不默认补题。',
  },
  promptFragments: {
    roleNoun: '物理学习教练',
    noteExamplePolicy: '例题必须带单位标注、每步推导依据、量纲一致性检查。',
    variantExamplePolicy: '变式题保持同一物理定律，改变数值、单位或场景设定。',
    teachingStyle: '先检查物理量与单位是否匹配，再给推导路径，最后做量纲检验。',
    checkQuestionPolicy: '检查题应聚焦一个公式应用、单位换算或量纲分析。',
    learningIntentPolicy: '把模糊目标改写成具体物理量推导、定律应用或单位换算练习。',
  },
  causeCategories: [
    { id: 'unit', label: '单位错误', description: '单位换算 / 单位丢失 / 单位错配', review_priority: 5 },
    { id: 'dimension', label: '量纲错误', description: '量纲不平衡 / 物理意义错误', review_priority: 5 },
    { id: 'formula', label: '公式错误', description: '公式记错 / 公式适用条件错', review_priority: 4 },
    { id: 'concept', label: '概念理解', description: '对物理定义、定律、原理的理解错误', review_priority: 4 },
    { id: 'computation', label: '计算错误', description: '数值代入 / 运算 / 进位错', review_priority: 2 },
    { id: 'careless', label: '粗心', description: '看错条件、漏抄数据、符号写错', review_priority: 1 },
    { id: 'other', label: '其他', description: '不在上述分类内的错', review_priority: 1 },
  ],
  renderConfig: {
    notation: 'latex',
    fontFamily: 'system-default',
    codeHighlight: false,
  },
  schedulingHints: {
    // TODO(N+1): 单位 / 量纲错误的 review interval 可能要短于计算错误（错的概念性强）
    // 现 P0 起步用默认值
  },
  judgeCapabilities: ['exact', 'semantic'], // P1 增 'unit_dimension'，P2+ 可能增 'steps'
};
```

## 6. Partial → FSRS Rating Advisory 形态

### 6.1 advisor 函数 schema

```ts
// src/server/review/rating-advisor.ts
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { FsrsRatingT } from '@/core/schema/business';

export interface RatingAdvice {
  rating: FsrsRatingT | null; // null = 不可用（unsupported / no judge）
  reason: string; // 人类可读的推荐理由
  evidence_score: number | null; // 用于 UI 显示 "score: 0.6 → hard"
}

export function judgeResultToRatingAdvice(
  result: JudgeResultV2T,
): RatingAdvice {
  // 6 分支：见 §3 P3 #1
}
```

### 6.2 6 分支映射表

| coarse_outcome | score 范围 | rating 推荐 | reason 示例 |
|---|---|---|---|
| correct | ≥ 0.9 | easy | "{capability} 给出 correct 且 score 0.9+，推荐 easy" |
| correct | ≥ 0.7 | good | "{capability} 给出 correct，score {x}，推荐 good" |
| partial | ≥ 0.5 | hard | "{capability} 给出 partial credit {x}，方向对但有偏差，推荐 hard" |
| partial | < 0.5 | again | "{capability} 给出 partial credit {x}，偏差较大，推荐 again" |
| incorrect | 任意 | again | "{capability} 给出 incorrect，推荐 again" |
| unsupported | 任意 | null | "{capability} 给出 unsupported（不在判分能力内），advisory 不可用" |

### 6.3 不动 ABI 的边界

`scheduleReview(prevState, rating, now)` 的 ABI **不变** —— advisor 不接入 FSRS 内核。 advisor 是 UI 层 +留痕层的"信号注入"，FSRS 仍按 4 档离散运行。原因：
- 保留 ts-fsrs 内核与社区版本兼容
- 保留人类信号 override（用户可不接受 advisory）
- 留 Option B/C 后续探索空间（如果 acceptance rate 显示 advisory 几乎从不被改，再考虑绕过 4 档）

## 7. `unit_dimension@1` Capability 形态

### 7.1 Manifest

```ts
// src/core/capability/judges/unit_dimension.ts
import type { JudgeCapabilityRunner } from '../types';

export const unitDimensionV1Capability: JudgeCapabilityRunner = {
  manifest: {
    id: 'unit_dimension',
    version: 1,
    kind: 'judge',
    cost: 'local', // deterministic accelerator 主路径；LLM fallback 偶发
    latency: 'sync', // accelerator sync；fallback async（runner 内部决定）
    stability: 'experimental',
    description: '物理量单位与量纲判分；先 deterministic 后 LLM fallback。',
  },
  run: async (input) => {
    // §7.2-§7.4 详
  },
};
```

### 7.2 Input schema

```ts
export const UnitDimensionJudgeInput = z.object({
  student_answer: z.string().min(1), // "30 m/s" 或 "三十米每秒"
  reference: z.object({
    value: z.number(),
    unit: z.string(), // SI form, e.g. "m/s"
    tolerance: z.number().default(0.05), // 5% relative
  }),
  question_context_md: z.string().optional(), // 题面，供 LLM fallback 用
});
```

### 7.3 处理流程

1. **Deterministic accelerator**：解析 student_answer 为 `{ value, unit }`；调用 mathjs unit lib normalize 到 SI 形式
2. 如果 accelerator 解析失败（含中文单位 / 复合形式 / 隐式单位）→ **LLM fallback**（mimo-v2.5）做单位换算 + 量纲分析
3. 分类：单位对 + 数值对 → correct；单位对 + 数值小偏差 → partial（高分）；单位错但量纲对 → partial（中分）；量纲错 → incorrect；解析不出 → unsupported
4. 输出 `JudgeResultV2`，capabilityRef.id='unit_dimension', version=1, scoreMeaning='unit_dimension_v1'

### 7.4 4 错误路径（详 §3 P2 #3）

| 错误类型 | 例子 | score | coarse_outcome | signal |
|---|---|---|---|---|
| 全对 | reference="30 m/s"，student="30 m/s" | 1.0 | correct | — |
| 数值近 | reference="30 m/s"，student="29.5 m/s"（误差 <5%） | 0.7 | partial | numeric_close |
| 数值远 | reference="30 m/s"，student="50 m/s"（误差 ≥5%） | 0.3 | incorrect | numeric_off |
| 单位错量纲对 | reference="30 m/s"，student="30 km/h" → SI 后 ≈ 8.3 m/s | 0.4 | partial | unit_mismatch_same_dimension |
| 量纲错 | reference="30 m/s"（速度），student="30 m"（长度） | 0.0 | incorrect | dimension_mismatch |
| 解析失败 | student="忘了" 或非数值 | — | unsupported | — |

## 8. Risks / Non-goals / Phase-deferred

### 8.1 Risks

1. **Framework diff 不为 0**（acid test 1/2 失败）：如果 physics profile 或 unit_dimension capability 加完后，框架文件出现非预期 diff，**phase 回退**，把 diff 原因写入 spec deltas 文档；user 决策是否调整 spec / 接受 diff（spec 本身可能藏了"框架以为已经泛化但其实没"的假设）。
2. **mathjs unit 库覆盖度不够**：deterministic accelerator 命中率太低 → LLM fallback 比例过高 → 成本失控。P2 内 monitor LLM fallback ratio；如果 >40% 则评估是否扩 fixture 覆盖或换 lib。
3. **Advisory 推荐与用户实际选差距过大**：P4 closeout 看 acceptance rate；如果用户接受 < 50%（即频繁改档），说明映射规则不准，P4+ 调阈值。
4. **wenyan / math regression**：每 phase exit criterion 都要 wenyan + math fixture 跑过；如果回退说明 framework 假设藏在 wenyan/math 路径。

### 8.2 Non-goals（写进 spec 顶部，重复一次防止 scope creep）

- subject #4（programming / english）—— N+2 spec
- physics 图像题 / 示意图 capability —— math figures 字段够用，本期不专攻多模态
- partial → mastery view（ADR-0012 后续工作）
- partial 直接进 FSRS（Option B/C）—— Option A 真实使用后再决定
- ts-fsrs 内核改动
- Cross-subject 题目（同一题跨 wenyan/math/physics）
- Correction event production 负载压测（math MVP closeout 的 N+1 follow-up）
- `unit_dimension@2`（更激进的量纲推导）—— version=1 真实使用后再考虑

### 8.3 Phase-deferred

| 项 | 推迟到 | 原因 |
|---|---|---|
| physics + math 共享 steps@1 capability（公式推导题） | P5（本 spec 外）or 下一个 subject 期 | 本 spec 不验证 capability 跨 subject 复用；math 已用 steps，physics 验完 unit_dimension 后下期再 verify |
| Physics image fixtures（含图像的物理题） | N+1 | math figures 字段 ready，需要时复用即可，本期不专攻 |
| Schedulinghints 按 cause 调整 interval | N+1 | profile 留了字段，本期不实装 |
| Advisory acceptance rate 分析 | P4 closeout 自然产出 N+1 follow-up | 需要真实使用数据 |

## 9. Open Questions（写 spec 时未敲定，需 P-1 或 P0 中确认）

1. **mathjs unit 库**：项目已有依赖吗？如果没有，P-1 verify 加 `mathjs` 是否会引入显著 bundle bloat（本 spec 是 server-only，应当问题不大，但确认）。备选：自写量纲分析（用 SI base 7 元组 + 有理数指数）—— 更轻但工作量大。
2. **physics fixture seed**: 数据来源（教材题 / 自编 / AI 生成）？math MVP 用自编 10 道；本 spec 沿用相同手感（自编 10 道），P-1 内 confirm。
3. **review UI advisory 视觉**：默认 highlight 推荐档（按钮变色）vs 显示文字提示（"建议：hard"）vs 两者结合？设计偏向"按钮 highlight + tooltip 显示 reason"；P3 内确认。
4. **`outcome` 字段还要不要二元**：current `outcome: 'success' | 'failure'` 是 review event payload 字段。P3 实施时是否新增 `outcome: 'partial'` 中间态？保守做法：不动（仍 success/failure），advisory 信号通过 judge_advice 字段独立留痕；event projection / mastery view 后续按需扩。本 spec **不改 outcome enum**。

---

**Spec sign-off blockers**: 上面 §9 4 个 Open Question 在 P-1 phase 内确认；其余 spec 内容已敲定。
