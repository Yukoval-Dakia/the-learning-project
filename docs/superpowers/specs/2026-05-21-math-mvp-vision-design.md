# Math MVP (Vision-as-Input) Design

**Status**: design spec for v0.3 Subject #2 + Foundation 收尾。
**Date**: 2026-05-21.
**Scope**: 引入 math 作为第二 subject（验证 framework 通用化），同时按 math 路径驱动 Foundation A/B/C 的剩余收尾、数据层多模态承载补强、drift 清零。
**Anchor decisions**: [ADR-0014 — Generalized Learning Activity + Capability Registry](../../adr/0014-generalized-activity-and-capability-registry.md), [v0.3 roadmap](../../planning/v0.3-generalized-ai-learning-framework.md) §1.5（Foundation → Product Track → Later）。
**Non-scope**: sympy 符号等价；自动 step extraction 独立 pipeline；外部 MCP / Plugin / Track F 完整多模态流；programming subject；其他 capability（`semantic@1` / `unit_dimension@1`）。

## 1. Goal

把 math 作为 v0.3 Foundation 的 **pressure subject**，让以下断言**通过真实运行被验证**：

1. SubjectProfile 能承载非 wenyan 的学习语义（math 的 LaTeX 渲染、step 判分、数学错因分类）
2. CapabilityRegistry 能挂载第二种 judge route（`steps@1`），且 `JudgeResultV2` 的 partial credit 真在 UI 端被消费
3. ActivityRef 路径下 math 题型不退化到 `question_id` 兜底
4. **题目数据层支持多模态结构化存储 + agent 结构化读取/编辑**（这是当前 schema 的真实缺口；详 §4）
5. learning_record / memory_brief_note / knowledge / question / artifact 之间的强连接对 math 这条新路径同样成立

不在本 spec 范围内的事情，靠后续 phase 完成；本 spec 收口的是上面 5 条断言能成立的最小切片。

## 2. Drivers / 选型记录

为后续 Agent 与人能复盘"为什么这样设计"，把关键选型写下：

### 2.1 方案 B（math-driven 收尾）而非方案 A（foundation-first）

Foundation 工作的价值是被 math 验证后才显现的。脱离 math 单独做 ActivityRef 全迁移、profile-blind 全量清扫，缺乏判断"清完没有"的依据，容易停在"主干 ship、legacy 不动"——这就是 Foundation A 当前的状态。先用 math 当压测对象，触碰到的 legacy 现地修；不在 math 路径上的 legacy 由 M3 单独收口。

### 2.2 Math 作为 Subject #2（而非 english / programming）

Math 对 Foundation A（CapabilityRegistry）和 Foundation C（JudgeResultV2 + partial credit）的压力最大——step 判分、连续 score、LaTeX 渲染都是 wenyan 路径不存在的新维度。English 压力部分重叠 wenyan（都是语言），programming 需要 sandbox/runtime 是大切片。Math 是"对 Foundation 最狠的最小压测"。

### 2.3 档 3（vision-as-input）而非档 1（纯文本）/档 2（图片附件）

档 3 覆盖 math 真实场景——手写草稿可独立成为提交。**单次 vision LLM call 端到端**（不做 OCR / step extraction / alignment pipeline）。决策依据：

- OCR / step extraction / alignment 在现代 vision LLM 里是隐式完成的"已解决问题"——遵循 memory `feedback_anti_overengineering` 原则
- 学生输入侧三条都可选（图 / 文本步骤 / 文本 final_answer），唯一约束是至少一项不为空——遵循 memory `feedback_ai_agency`："AI 软判断 + evidence 留痕"
- 真实保留的风险是 (a) endpoint vision 能力未验证 (b) 同图重判一致性需 sanity check，二者都在 phase 内有显式 gate

### 2.4 Phase M-1 数据契约补强独立成 phase

verify 现状（详 §4）后发现：`question` 表本身没有 `figures` / `image_refs` / `structured` 字段，导致 `question_block → question` import 路径在派生 markdown 时丢图。wenyan 没图所以没暴露，math 第一道带图的题就断。这是 vision math 闭环的**真实前提**，不能塞在 math 骨架阶段顺手做。

## 3. Phase 序列

总投入估计 **12-17 个工作 day**，可在 2.5-3.5 周内推完。每个 phase 有显式 exit criterion，不达就回退或拆 phase；不"差不多就过"。

### Phase M-1 — 多模态题数据契约补强 — 2-3 day

**Goal**: 让 `question` 表自身承载多模态结构化字段；agent 能 read/edit 结构化 question；ADR-0002 原则从 `question_block` 推广到 `question`。

**Scope**:

1. Migration `drizzle/0008_question_multimodal.sql` 给 `question` 表新增：
   - `figures: jsonb` (`FigureRefT[]`, default `[]`)
   - `image_refs: jsonb` (`string[]`, default `[]`)
   - `structured: jsonb` (`StructuredQuestionT | null`)
2. `src/server/ingestion/` 里 `question_block → question` import 路径修复：保留 `figures` / `image_refs` / `structured`，不在派生 markdown 时丢
3. `question.kind` 增加 `'derivation'` 值（schema validator 同步）
4. `QuestionForJudge` contract（`src/server/ai/judges/question-contract.ts`）扩展为 `{ prompt_md, reference_md, figures, structured?, choices_md?, image_refs }`；judge 内部决定要不要消费 figures（`exact` / `keyword` 忽略，`steps@1` 必读）
5. ADR-0002 patch：把 "markdown 由 structured 现场派生不持久化" 原则明文推广到 `question`
6. `pnpm audit:schema` 通过：新字段 write path 在 import 路径里；不需要 allowlist

**Exit criterion**:
- 一道 fixture math 题（带 1 张图）从 ingestion → question 持久化全程不丢图；DB 查询能看到 `question.figures[0].asset_id` 非空
- 现有 wenyan judge 路径 regression 测试通过（`exact` / `keyword` 不读新字段）
- ADR-0002 patch 已提交
- `pnpm audit:schema` 通过

### Phase M0 — Math 骨架 + Foundation 探针 + vision endpoint pre-flight — 2-3 day

**Goal**: 跑通 math choice + fill_blank 一次端到端做对/做错；vision endpoint 验证；列出 math 路径上"踩到但还在用 question_id / 还在 wenyan 硬编码 prompt"的所有位点（不修，只记）。

**Scope**:

1. **Pre-flight（30 秒）**: 给 xiaomi/mimo endpoint 发一张测试图 + 文本题干；确认返回 structured output 含视觉信息。
   - 通过 → 继续 M2 走 vision judge
   - 不通过 → 立即停 phase，让 user 决策（推迟 vision / 切 provider / 退回档 2）
2. `src/subjects/math/profile.ts` 最小 SubjectProfile（详 §5；M0 只声明 `questionKinds: ['choice', 'fill_blank']` + `judgeCapabilities: ['exact@1']`，所有未来字段加 `// TODO(phase-Mx)` 注释）
3. 注入 `SubjectRegistry`；profile validator 验 `renderConfig.notation` + 声明的 capability 真在 registry 注册
4. 手工 seed 10 道 math fixture（choice 5 + fill_blank 5）到 `subjects/math/fixtures/`，不走 AI 生成
5. 端到端跑一次（学习 → 答题 → judge → review 队列）
6. **Drift 探针**：把 math 路径上踩到"`question_id` 兜底 / wenyan-coupled prompt / `getTaskSystemPrompt` 走 default 分支"的所有位点列入 M0 执行时新建的 plan 文档顶部 drift 清单（M1 修；非 math 路径的 M3 修）

**Exit criterion**:
- vision endpoint pre-flight 结果文档化（pass/fail + 测试 fixture commit）
- 10 道 math 题在 review 队列里能答；正确/错误分别产生符合 `JudgeResultV2` 的 judge event
- wenyan 题型 regression 测试通过（行为不变）
- math drift 清单已写

### Phase M1 — 沿 math 路径迁移 ActivityRef + profile-blind 收尾 — 2-3 day

**Goal**: M0 drift 清单里"math 路径触发的 legacy" 全部迁移；**不在清单里的不动**。

**Scope**:

1. ActivityRef 迁移：math 路径不再触发 `question_id` 兜底
2. Math 走的所有 task system prompt 都走 `getTaskSystemPrompt(kind, subjectProfile)`；不进 default 分支
3. `src/ai/registry.ts` 里被 math 触碰的 task 的 wenyan-coupled `systemPrompt` 字段加 deprecated 注释（详 §6 注释规范）
4. Profile validator 增强：扩展验证 `renderConfig.notation` 合法值（`'latex' | 'wenyan' | 'plaintext' | 'code'`）；老 wenyan profile 显式补 `notation: 'wenyan'`，不允许走兜底
5. 跑 `/audit-drift`，确认 math 路径上的所有 finding 都已清

**Exit criterion**:
- Math 答题路径中无 `question_id` 出现（端到端 trace 验证）
- Math task 的 system prompt 来自 `task-prompts.ts` 而非 `registry.ts` 字符串字段
- 老 wenyan profile 显式声明 `renderConfig.notation: 'wenyan'`
- `/audit-drift` 报告中 math 路径相关条目清零（非路径条目仍在，M3 处理）

### Phase M2 — `steps@1` capability + vision judge + KaTeX 渲染 — 5-6 day

**Goal**: 引入 `steps@1` LLM rubric capability（vision-aware，单 call 端到端）；KaTeX 渲染在 review/note/teaching surface 全部接通；partial credit 在 UI 端被消费。

**Scope**:

1. `steps@1` capability 落地（详 §7）：单 vision LLM call、structured output、`final_answer_text` 完全可选、evidence 含 LLM 提取的 final_answer 文本化
2. `JudgeResultV2` 的 `score` (0..1) + `scoreMeaning: 'steps-v1-weighted'` + `coarseOutcome` + 每步 verdict + capabilityRef 完整流转
3. KaTeX 渲染接入 `renderConfig.notation === 'latex'` 路径；review / note / teaching 三个 surface 都走同一个 render adapter
4. Math derivation 题型上线：5-10 道 fixture（含图片步骤），覆盖 `choice` / `fill_blank` / `derivation` 三类
5. 学生输入侧 primitive：图片 0..N + 文本步骤可选 + 文本 final_answer 可选；至少一项不为空
6. UI 显示 judge route 选择理由（"为什么走 steps 而不是 exact"——读 `capabilityRef`）
7. **Sanity check 测试**：同一份图 + 答案重判 3 次，分差 < 0.1（单测脚本，不进 CI 默认套）
8. `appealable: true` 流转通：UI 上 partial credit 题型能点 appeal 写 event；M2 不实际重判（M3 或后续 phase）

**Exit criterion**:
- 5-10 道 derivation 题（含图片）能走完闭环：答题（图+/-文本）→ vision judge → JudgeResultV2 → UI 显示 partial credit + evidence + judge 理由
- KaTeX 渲染 3 个 surface 正确
- 同图重判 sanity check 通过（脚本输出 < 0.1）
- Math profile 的 `judgeCapabilities: ['exact@1', 'steps@1']`；profile validator 通过

### Phase M3 — 非路径 legacy 收尾 + drift 清零 — 1-2 day

**Goal**: 清非 math 路径的剩余 ActivityRef legacy 和 registry.ts 死代码；补 ADR-0015；下一次 `/audit-drift` 没有这两条 finding。

**Scope**:

1. ADR-0015 起草并 merge：`learning_record` + `memory_brief_note` 的语义边界、单一所有者原则（对齐 ADR-0005）、与 `event` / `learning_session` 的关系（这两条来自 2026-05-20 drift 报告）
2. 非 math 路径的 ActivityRef legacy：要么彻底迁移到 ActivityRef，要么显式 deprecated 注释
3. `src/ai/registry.ts` 里所有未迁移 task 的 `systemPrompt` 字段一次性 deprecate（或删除字段，改 optional——视当时实际使用情况）
4. 跑 `/audit-drift`，确认 2026-05-20 报告里 2 条 finding 已清零

**Exit criterion**:
- ADR-0015 merged 到 main
- `/audit-drift` 输出报告中 §"learning_record + memory_brief_note 无 ADR" 和 §"registry.ts systemPrompt 死代码" 两条均不再出现
- 全部 phase-deferred 字段都有显式 TODO 注释（详 §6）

## 4. 数据契约现状 verify 记录

为后续 Agent / 人能查"为什么 M-1 必须先做"，把 2026-05-21 verify 结果固化：

### 4.1 题目多模态结构化存储

- `source_asset` 表（`src/db/schema.ts:67-78`）含 mime / sha256 / bbox，多模态资产基础完备
- `question_block.figures: FigureRefT[]`（`src/db/schema.ts:121`）+ `structured: StructuredQuestionT`（`src/db/schema.ts:119`）+ `image_refs` / `crop_refs`（`src/db/schema.ts:125-126`）—— **ingestion 层完整**
- `StructuredQuestion` Zod schema（`src/core/schema/structured_question.ts`）含 `source: 'agent_edit'`，设计上允许 agent 编辑
- **`question` 表（`src/db/schema.ts:146-172`）只有 `prompt_md` / `reference_md` / `choices_md` 文本字段；没有 `figures` / `image_refs` / `structured`**
- `question_block → question` import 走 `structuredToPromptMarkdown` 派生（`src/core/schema/structured_question.ts:128-156`），图在派生中丢失

### 4.2 Agent 结构化读取/编辑

- Judge 路径读 `question.prompt_md` + `question.reference_md` 字符串（`src/server/ai/judges/question-contract.ts:35-36, 134-135`）
- 无 question 级结构化 read API
- ADR-0002 的"markdown 由 structured 现场派生不持久化"原则在 `question` 层无法贯彻（字段都没有）

### 4.3 题目 / 记忆 / 学习记录 / 知识点强连接

`learning_record` 是天然 hub（`src/db/schema.ts:213-245`），含 `question_id` / `attempt_event_id` / `learning_item_id` / `artifact_id` / `knowledge_ids` / `source_document_id` / `asset_refs`，且有索引（`learning_record_question_idx` / `_attempt_idx` / `_origin_event_idx`）。`memory_brief_note.recent_*_evidence_ids` 指 event。`question.knowledge_ids` / `learning_item.knowledge_ids` / `artifact.knowledge_id` 都接通。**这部分不需要动**。

## 5. Math SubjectProfile 形态（M0 起点 → M2 增补）

```ts
// src/subjects/math/profile.ts
export const mathProfile: SubjectProfile = {
  id: 'math',
  displayName: '数学',
  version: 1,

  languagePolicy: {
    uiLanguage: 'zh-CN',
    explanationStyle: 'exam',
  },

  // TODO(phase-M2): 增补 'derivation'；见 §3 Phase M2
  questionKinds: ['choice', 'fill_blank'],

  renderConfig: {
    notation: 'latex',
    fontFamily: 'system-default',
    codeHighlight: false,
  },

  judgePolicy: {
    defaultByQuestionKind: {
      choice: 'exact',
      fill_blank: 'exact',
      // TODO(phase-M2): derivation → 'steps'；steps@1 capability 在 M2 落地
    },
    allowAppeal: true,
    uncertaintyThresholds: { borderlineLow: 0.4, borderlineHigh: 0.7 },
  },

  sourcePolicy: {
    preferredSources: ['textbook', 'user_material'],
    // TODO(phase-M3 或后续): math fixture 阶段不强求 citation
    citationRequiredFor: [],
  },

  notePolicy: {
    sectionKinds: ['definition', 'formula', 'example', 'pitfall', 'check'],
    examplePolicy: 'worked-step',
    artifactTemplates: {},
  },

  promptFragments: {
    attribution: '从计算错、公式记错、单位错、步骤跳跃、概念错中选一个最贴近的',
    noteGeneration: 'math note 的 example 要展示完整步骤，formula 用 LaTeX',
    teachingTurn: '允许学生先尝试再讲解，错误时优先指出步骤断层',
    variantGeneration: '保持核心公式不变，仅替换数值或场景',
  },

  // M0
  judgeCapabilities: ['exact@1'],
  // TODO(phase-M2): + 'steps@1'（LLM rubric / vision-aware；不引入 sympy）

  schedulingHints: {},

  // TODO(phase-N+1 / ADR-0014 §Phase N+1): profile-driven causeCategories
  causeCategories: undefined,
};
```

老 wenyan profile 必须显式补 `renderConfig.notation: 'wenyan'`（不允许走默认值兜底）。

## 6. 注释规范（贯穿全 phase）

参见 memory `feedback_phase_deferred_comments` — 占位 / 兜底 / deprecated 字段必须留显式注释。

三类位点的注释模板：

- 占位字段：
  ```ts
  // TODO(phase-Mx): xxx；见 docs/superpowers/plans/YYYY-MM-DD-...md §Mx
  ```
- 兜底分支：
  ```ts
  // fallback: <场景>；正式实现见 ADR-NNNN / plan-XXX
  ```
- deprecated 字段：
  ```ts
  // deprecated: runtime 走 <真路径>；保留以兼容 <调用方>，<phase> 后移除
  ```

注释必须给出 (a) 当前是占位/deprecated、(b) 何时/在哪个 phase/ADR 处理、(c) 在哪查上下文。

## 7. `steps@1` Capability 形态（M2）

### 7.1 学生输入

- 图片 0..N 张（asset 上传走 `app/api/assets/*` + `src/server/r2.ts`）
- 文本步骤可选
- 文本 final_answer 可选
- 唯一约束：图 / 文本步骤 / 文本答案至少一项不为空

UI 提示："写不下就留空，我会从图里读"。

### 7.2 Fixture reference_solution

```ts
{
  questionId: 'math-derivation-001',
  kind: 'derivation',
  prompt: '求 ∫(2x+3)dx',
  reference_solution: {
    expected_signals: [
      '识别为不定积分，按幂法则分项积分',
      '∫2x dx = x²；∫3 dx = 3x',
    ],
    final_answer: 'x² + 3x + C',
    // 仅在学生提供文本 final_answer 时用作加速比对；可空
    answer_equivalents: ['x^2 + 3x + C', 'x*x + 3x + C'],
  },
  step_weight: 0.4,
}
```

`expected_signals` 是"对的步骤应该体现什么"，不是死答案文本；math 解法多解，让 vision LLM 判"这步有没有体现核心信号"。

### 7.3 Capability manifest

```ts
// src/server/judges/capabilities/steps-v1.ts
export const stepsV1Manifest: CapabilityManifest = {
  id: 'steps@1',
  inputKinds: ['math:derivation'],
  outputContract: 'JudgeResultV2',
  costTier: 'llm-rubric',
  description: 'vision-aware LLM rubric 式步骤判分；按 step_weight + final_weight 加权出 partial credit',
};
```

### 7.4 Judge 流程

```ts
export async function stepsV1Judge(input: {
  prompt: string;
  reference_solution: {
    expected_signals: string[];
    final_answer: string;
    answer_equivalents: string[];
  };
  student_image_refs: AssetRef[];      // 可以是 []（学生没拍图）；前端层保证三者至少一项非空
  student_text_steps?: string[];
  student_final_answer_text?: string;
  step_weight: number;
}): Promise<JudgeResultV2> {
  // 1. 加速分支：student_final_answer_text 非空且命中 answer_equivalents → final_answer_match=true，跳过 LLM
  //    否则全部交给 vision LLM
  //
  // 2. 单次 vision LLM call（structured output，Zod schema 约束）：
  //    in:  prompt + reference_solution + student_image_refs + student_text_steps + student_final_answer_text
  //    out: {
  //      extracted_steps: [{ idx, content, verdict, comment }],
  //      extracted_final_answer: string,   // LLM 把图里答案转文本，evidence 用
  //      signal_verdicts: [{ signal_idx, verdict: 'correct'|'partial'|'wrong'|'skipped', comment }],
  //      final_answer_match: boolean,
  //      final_answer_comment: string,
  //      confidence: number,
  //    }
  //
  // 3. 合成 JudgeResultV2:
  //    score = step_weight * (Σ verdict_weight) / signal_verdicts.length
  //          + (1 - step_weight) * (final_answer_match ? 1 : 0)
  //    verdict_weight: correct=1, partial=0.5, wrong=0, skipped=0
  //    coarseOutcome: score≥0.85 → 'pass'; ≥0.4 → 'partial'; else 'fail'
  //    scoreMeaning: 'steps-v1-weighted'
  //    evidence: { image_refs, extracted_final_answer, signal_verdicts, final_answer_comment }
  //    capabilityRef: 'steps@1'
  //    appealable: true
}
```

### 7.5 稳定性防线

1. **Structured output 强约束** — Zod schema 让 LLM 输出 `signal_verdicts.length === reference_solution.expected_signals.length`；不允许自创信号
2. **`answer_equivalents` 加速分支** — 学生主动打字时省 LLM call + 给 deterministic 比对
3. **重判保留历史** — rejudge 写新 event 不覆盖（JudgeResultV2 contract 既有约束）
4. **同图重判 sanity check** — M2 单测脚本，3 次重判分差 < 0.1（不进 CI 默认套）

## 8. ActivityRef 迁移策略

不做全量迁移，沿 math 路径定位。M0 探针阶段产出 drift 清单（含路径、文件、line range），M1 按清单逐条修。

清单结构（示例）：

```md
## Math 路径触发的 ActivityRef legacy

### 1. /api/review/next 答题 → judge 派发
- 路径: app/api/review/next → src/server/review/select.ts:L#
- 现状: 用 question_id 查 question；返回 JudgeRouteContext.question_id
- 应改: 用 ActivityRef.id 查；返回 ActivityRef
- 风险: review 队列查询多处依赖 question_id 索引；改时需同步索引

### 2. ...
```

非 math 路径的 ActivityRef legacy 在 M3 收尾，不和 math 缠。

## 9. Drift 收尾

来自 [2026-05-20 audit](../../audit/2026-05-20-drift.md) 的 2 条 finding 在 M3 处理：

1. ADR-0015 缺失：`learning_record` + `memory_brief_note` 无 ADR 追认
2. `src/ai/registry.ts` 死代码 `systemPrompt`（wenyan 硬编码）

M1 顺手处理 math 触碰的部分（deprecated 注释、profile validator 增强），M3 收尾剩余。

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| xiaomi/mimo endpoint 不支持 vision 输入 | M0 pre-flight 显式 gate；不支持就停 phase 让 user 决策 |
| vision LLM 同图重判不稳定 | M2 sanity check 脚本（3 次重判分差 < 0.1）；evidence 暴露 extracted_final_answer 供 user 自查 |
| `expected_signals` 文本提示对 vision LLM 表达能力不够 | M2 fixture 编写时实测 + 调优 prompt；不达标时 reference_solution 补充 `signal_negative_examples`（推后到 M3+） |
| M-1 数据契约改动影响 wenyan regression | M-1 exit criterion 含 wenyan regression 测试；judge 内部决定是否消费新字段（`exact` / `keyword` 不读） |
| Vision call cost 超预算 | M2 加 `cost_ledger` 写入；超阈值时 UI 显示 warning（M3+ 才考虑硬限制） |
| math fixture 编写耗时 | M0 / M2 fixture 都手工写不走 AI 生成；总计 15-20 道题，每道 5-10 分钟，纳入 phase 估时 |

## 11. Non-goals

- sympy / 符号等价判断
- 独立 OCR pipeline / 独立 step extraction 模块（vision LLM 隐式做）
- 自动从用户教材生成 math fixture（M2 全手工 seed）
- 多 subject 并行上线（math 之后再考虑 english / programming）
- 外部 MCP / Plugin / 完整 Track F 多模态流
- 申诉真实重判（M2 仅记录 event，重判逻辑后续 phase）

## 12. Pre-flight checklist（执行任何 phase 之前）

- [ ] `which docker` + Docker daemon running（testcontainer 依赖）
- [ ] `pnpm typecheck` baseline 通过
- [ ] `:3000` 谁占着确认（参见 memory `feedback_dev_server_port_check` — OrbStack 容器长期占 :3000，pnpm dev 会跳 :3001）
- [ ] `INTERNAL_TOKEN` / `DATABASE_URL` / `ANTHROPIC_*` env 都在 `.env.local`
- [ ] M0 启动前补一项：vision endpoint 测试图调用结构化输出 pass/fail

## 13. Testing strategy

- Unit: capability handlers、profile validator、`QuestionForJudge` contract、score 合成函数
- Integration: math 端到端（M0: choice + fill_blank；M2: + derivation）走真 testcontainer Postgres + mock vision LLM
- Regression: wenyan 端到端在每个 phase exit 时全跑（确保不退化）
- Sanity: M2 同图重判 3 次分差脚本（独立脚本，不进 CI 默认套，phase exit 前手动跑）

## 14. Open questions

均不阻塞 M-1 启动，但需要在对应 phase 之前 resolve：

1. **M2 之前**: `step_weight = 0.4` / `final_weight = 0.6` 这个分配是否合理？应试场景下 final 权重是否应更高（0.7-0.8）？—— phase M2 启动前 1-2 道 fixture 实测后定
2. **M3 之前**: `registry.ts` 里非 math 触碰的 `systemPrompt` 字段 deprecate 还是删除？—— M3 启动时检查实际使用情况
3. **M3 之后**: profile-driven `causeCategories` 何时落地？—— ADR-0014 §Phase N+1 范围；本 spec 不决定
