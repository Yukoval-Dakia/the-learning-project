# Artifact: Tool — `tool_quiz`

> Last reviewed: 2026-05-28 (T-PD8)
>
> 见 [架构基础](../architecture.md) 了解 Artifact 多态化、`question` / `event` / `material_fsrs_state` schema 和相关 Task 注册。
> Review session lifecycle 详见 [ADR-0013](../adr/0013-review-session-lifecycle.md)；event-driven 核见 [ADR-0006 v2](../adr/0006-encounter-replaces-mistake.md)。

`tool_quiz` 是 Tool-type Artifact 的**当前唯一实例**。本文档同时是 tool_quiz artifact 的实现规范——题目生产、答题、判定、申诉的完整生命周期。

---

## 0. 实施现状（2026-05-28）

> 本 doc 描述的完整 `tool_quiz` artifact / JudgeRouter / Answer / Judgment / UserAppeal 仍是 roadmap；但当前 review 已经有 `learning_session(type='review')` 生命周期，答题事实走 `event` + FSRS 投影，不再是无 session 的裸 review flow。

| 设计概念 | 现状 |
|---|---|
| `question` 表（统一题库） | ✅ 落地 (`src/db/schema.ts` L146)，被 `event(action='attempt', subject_kind='question')` 引用 |
| `answer` 表 | ✅ 仍存在 (`src/db/schema.ts` L339)，承载答案 payload；`vision_extracted` / `image_refs` 字段保留 |
| `judgment` / `user_appeal` 表 | ❌ DROPped (ADR-0006 v2 / 1c.1 Step 1.4 Lane A)；判分走 `event(action='judge', subject_kind='event')`；申诉走 `POST /api/review/appeal` 创建新 `judge` event 并 chain `caused_by_event_id` |
| JudgeRouter + 7 种 judge kind | 🟡 `exact` / `keyword` 是 registry-backed local judge；`semantic` 通过 async `judgeAnswer` + `SemanticJudgeTask` 用于 prose embedded checks；`rubric` / `steps` / `multimodal_direct` / `ai_flexible` 仍是未来能力 |
| `tool_quiz` artifact 类型 + standalone vs embedded | ❌ artifact 表 schema 在但 0 写入 / 0 UI；embedded check 在 `artifact.body_blocks` 内联，attempt 走 `POST /api/embedded-check/attempt` |
| Review session | ✅ ADR-0013 已落地：`/api/review/sessions[/id/{end,pause,reopen,resume}]` 创建/生命周期，`/api/review/submit` 可带 `session_id`，孤儿清理由 route + pg-boss `coach_daily` 处理；advice/plan/weekly 走 `/api/review/{advice,plan,weekly}` |
| 复习 = standalone tool_quiz artifact | ❌ 仍未实现；当前是 review session + due/submit API |
| 变式题生成 + lifecycle | ✅ pg-boss `variant_gen` 写 draft `question(source='mistake_variant')`，状态机走 `mistake_variant` 表（ADR-0018） |
| 变式题双 pass verify | ✅ pg-boss `variant_verify` 已落，draft → active / broken 状态转换；三层防"错题繁殖"仍 Phase 2+ |
| AttributionTask 写 cause | ✅ 落地 `src/server/knowledge/attribute.ts`；输出走 `event(action='judge')`，payload 含 10 类 cause |

**当前真"答题"路径**：手动录入（`POST /api/records?kind=mistake`，read alias `POST /api/mistakes` 仍兼容） + FSRS 复习（`POST /api/review/sessions` → `GET /api/review/due` → `POST /api/review/submit` → session end）+ embedded check（`POST /api/embedded-check/attempt`）。整套 `tool_quiz` artifact / 完整 Judgment / appeal 仪式感推到 Phase 2。

---

## 1. 定位

### 1.1 Tool-type Artifact 在体系里的位置

```
Artifact (AI 产出物)
├── Note  (阅读型，被读)
│   ├── note_hub
│   └── note_atomic
└── Tool  (互动型，被用)  ← 本文档讨论这一族
    ├── tool_quiz       ← 当前唯一实例
    ├── tool_visualizer (Phase 3 候选)
    └── tool_<future>
```

### 1.2 tool_quiz 的两种存在形态

**Standalone**（独立 Artifact 行）：
- 每日 quiz（`source: daily`）
- Final quiz（`source: final`，关联 LearningItem）
- 模拟卷 / 用户保存的题集（`source: manual`）
- 复习 session（`source: review_session`，FSRS 到期错题集合，用完归档）

**Embedded**（inline 在 note section 内）：
- Note `check` section 末尾的 1~3 题自检
- 跟 section 1:1 强耦合，不另建 Artifact 行；section 直接持 `question_ids[]`

两种形态共用同一套 Judge v2 light 判题入口：同步 exact/keyword 走 registry；语义题走 `SemanticJudgeTask`；判题失败返回 `unsupported`，不直接记错。

### 1.3 职责与边界

**职责**：题目生产 → 答案接收 → 判定 → 反馈 → 错题入库。

**不负责**：
- 错题管理（见 [mistakes.md](mistakes.md)）
- 复习调度（FSRS 在 mistakes 模块）
- mastery 计算（见 [progress.md](progress.md)）

`tool_quiz` 只关心一道题的「问 → 答 → 判」生命周期，结果通过事件喂给其他模块。

### 1.4 Question 是统一题库

**`Question` 是题面、参考答案、评分标准的唯一存储**（single source of truth）。所有题相关的对象都引用 `Question.id`：

```
Question (统一题库)
  ↑ 被引用
  ├── tool_quiz Artifact.tool_state.question_ids[]   (standalone)
  ├── note_atomic.sections[check].embedded_check.question_ids[]   (embedded)
  ├── Mistake.question_id                            (做错事件)
  └── Mistake.variants[].question_id                 (变式题，本身也是 Question)
```

题面去重、变式题平等入题库、复习与 quiz 共用引擎——都建立在这个统一抽象上。

### 1.5 已入库题目的生命周期证据

凡是进入 `question` 表的题，都必须能回答这些问题：

| 问题 | canonical source |
|---|---|
| 这题什么时候进入系统？ | `question.created_at` |
| 它从哪里来？ | `question.source` / `source_ref` / `created_by` / `metadata` |
| 用户什么时候做过、做对还是做错？ | `event(action='attempt', subject_kind='question', subject_id=question.id)` |
| 它什么时候被复习过？ | `event(action='review', subject_kind='question', subject_id=question.id)` |
| 当前何时该复习？ | `material_fsrs_state(subject_kind='question', subject_id=question.id)` |
| 它有没有被保留成学习上下文？ | `learning_record.question_id` / `origin_event_id` |

不要把 `last_attempted_at`、`last_reviewed_at`、`review_count` 这类可派生字段直接塞回
`question` 表。题面表只保存稳定材料和来源；生命周期汇总由 reader / view 派生，例如
`QuestionActivitySummary`。

建议 `QuestionActivitySummary` 至少包含：

```ts
{
  question_id: string;
  recorded_at: string;
  source: string;
  source_ref: string | null;
  first_attempted_at: string | null;
  last_attempted_at: string | null;
  attempt_counts: { success: number; partial: number; failure: number };
  first_reviewed_at: string | null;
  last_reviewed_at: string | null;
  review_count: number;
  due_at: string | null;
  last_review_ref: string | null;
  linked_record_ids: string[];
}
```

---

## 2. 题型 (Question kinds)

```
choice               单选 / 多选
true_false           判断
fill_blank           填空（单空 / 多空）
short_answer         简答（1~2 句）
essay                论述（多段）
computation          计算（含步骤）
reading              阅读理解（基于 passage）
translation          翻译（如文言文 → 现代文）
```

每种 kind 决定**默认输入方式**和**默认判定方式**。

---

## 3. 输入方式 (Input kinds)

```
text         文字输入（默认）
option       选项点击（choice / true_false 用）
image        图片上传（手写 / 拍照）→ 视情况走 vision pipeline 或 direct multimodal
voice        语音（Phase 3+，暂不实现）
```

---

## 4. 判定方式 (Judge kinds)，cheap → expensive

```
1. exact              字面完全相等                          ~free
2. keyword            命中关键词集合                        ~free
3. semantic           AI 判语义等价                         $
4. rubric             AI 按结构化评分标准评分               $$
5. steps              AI 验证中间步骤 + 最终答案            $$
6. multimodal_direct  强模型直接处理 image + text 一次过    $$
7. ai_flexible        兜底：强模型 + 完整上下文 + CoT       $$$
```

每种 judge_kind 对应一个独立 Task（见 § 10）。Question 有默认 judge_kind，可在题目级用 `judge_kind_override` 强制。

---

## 5. 默认路由表

| Question kind | Default judge | 何时走 direct multimodal |
| --- | --- | --- |
| choice | exact | — |
| true_false | exact | — |
| fill_blank (定式答案) | exact / keyword | — |
| fill_blank (语义答案) | semantic | — |
| short_answer | semantic + keyword | answer 含 image 且 visual_complexity ≥ medium |
| essay | rubric | answer 含 image 且 visual_complexity ≥ medium |
| computation | steps | answer 是手写图片（含解题过程） |
| reading | semantic + rubric | — |
| translation | semantic + reference | — |

---

## 6. JudgeRouter — 唯一入口的路由逻辑

```
function judgeRouter(question, answer) -> Judgment:

  # Step 1: 处理图片输入
  if answer.input_kind == 'image':
    if shouldUseDirectMultimodal(question, answer):
      return JudgeMultimodalTask.run(question, answer)
    else:
      vision_text = VisionAnswerExtractTask.run(answer.image_refs)
      answer.vision_extracted = vision_text
      # fallthrough to text-based judge

  # Step 2: 选 judge_kind
  judge_kind = question.judge_kind_override or defaultJudgeFor(question.kind)

  # Step 3: 跑判定
  judgment = JudgeTaskRegistry[judge_kind].run(question, answer)

  # Step 4: borderline 触发 ai_flexible 兜底
  if 0.4 <= judgment.score <= 0.7 and judge_kind != 'ai_flexible':
    return JudgeFlexibleTask.run(
      question, answer,
      prior_judgment=judgment,
      triggered_by='borderline'
    )

  return judgment


function shouldUseDirectMultimodal(question, answer) -> bool:
  return any of:
    - question.visual_complexity in ['medium', 'high']
    - question.kind == 'computation' and 'handwritten' in answer.tags
    - question.judge_kind_override == 'multimodal_direct'
```

**实现注**: JudgeTaskRegistry 是 in-code 的 Map<JudgeKind, JudgeTask>。JudgeRouter 不调 LLM，纯逻辑路由。

---

## 7. 柔性兜底（ai_flexible）

### 7.1 触发条件

```
1. JudgeRouter step 4: borderline (score 0.4~0.7)
2. UserAppeal 提交（用户对 verdict 不服）
3. 同一答案重判 3 次方差大（Phase 3+ 的一致性检测，初期不做）
4. question.metadata.force_flexible == true
```

### 7.2 输入

JudgeFlexibleTask 跑 Opus（顶级 reasoning model）单次推理，输入：

```
{
  question: { prompt, reference, rubric, knowledge_ids, ... }
  answer:   { content_md, image_refs, vision_extracted, ... }
  user_history: 该用户在该知识点最近 N=10 条答题记录
  prior_judgment?: borderline 时上一次的 Judgment
  appeal_reason?:  appeal 触发时用户填写的理由
  triggered_by:    borderline | appeal | force
}
```

### 7.3 输出

详细 CoT 写入 `Judgment.evidence_json`，包含：

```
{
  verdict: correct | partial | incorrect
  score: 0~1
  reasoning_chain: [...]              # 显式推理步骤
  diff_with_reference: [...]          # 与参考答案的差异点
  rubric_breakdown?: [...]            # rubric 类的话给出每项评分
  agrees_with_prior: bool             # appeal 路径用
  feedback_for_user: text             # 给用户的友好反馈
}
```

---

## 8. 用户申诉权（UserAppeal）

UI 上每个 verdict 旁有「我觉得我答对了」按钮（措辞可调）。

### 8.1 流程

```
1. 用户点申诉 + 选填理由
2. 创建 UserAppeal 记录（关联 prior Judgment）
3. 触发 JudgeFlexibleTask (triggered_by='appeal')
4. 新建 Judgment (is_flexible_fallback=true, prior_judgment_id 指向旧 verdict)
5. 旧 Judgment.is_effective=false, 新 Judgment.is_effective=true
6. 副作用：
   - 若 verdict 从 [partial, incorrect] → correct: 撤销 mistake 创建（标 misjudged）
   - 若反向变化（罕见）：创建 mistake，feed mastery negative
   - 重新喂 mastery
7. UserAppeal.resolved_judgment_id = 新 Judgment.id
```

### 8.2 不可变性

**Judgment 一旦创建不再修改**。重判 = 新建一条。一道答案可以有多条 Judgment（按时间排），最新的 `is_effective=true`。

理由：审计追溯。三个月后能问"这题历经几次判定，每次为什么"。

### 8.3 限次

**同一 Judgment 最多被申诉 1 次**（防恶意烧 ai_flexible 预算）。已申诉过的 Judgment 不再显示申诉按钮。

---

## 9. Schema

> ⚠️ 下面 §9.3 的 `Judgment` / `UserAppeal` 是 Phase 1 sketch 期的 schema 设计参考，**两表已 DROP**（见 §0 现状表 + `src/db/schema.ts` L351-353 注释）。当前判分走 `event(action='judge', subject_kind='event', caused_by_event_id=<attempt_event_id>)`，appeal 走 `POST /api/review/appeal` 创建新 judge event 并 chain。`answer` 表仍在用于持久化答案 payload。读 sketch 时心里替换 Judgment / UserAppeal → judge event 即可。

完整 schema 见 [架构基础 § 七](../architecture.md#七数据模型骨架)。这里展开 quiz 子系统的关键字段。

### 9.1 Question（统一题库）

题面、参考答案、评分标准的唯一存储。所有题相关引用都通过 `question_id`。

```
Question
  id
  kind: choice | true_false | fill_blank | short_answer | essay
        | computation | reading | translation
  prompt_md
  reference_md
  rubric_json?
  judge_kind_override?
  visual_complexity?: low | medium | high
  → knowledge_ids[]
  difficulty: 1~5
  source: embedded | daily | final | dreaming | manual
        | vision_single | vision_paper | reverse_mark | mistake_variant
        | teaching_check
  source_ref?            # origin event / source document / artifact / attempt event / agent message / null
  draft_status?: draft | active   # 仅 mistake_variant 等需要双 pass 的题
  created_by: {task, version}
  metadata?: {
    force_flexible?,
    expected_input_kind?,
    source_document_id?,
    source_asset_ids?,
    crop_refs?,
    origin_question_block_id?,
    ...
  }
  created_at, updated_at, version
```

### 9.2 tool_quiz Artifact

`Artifact` 表中 `type=tool_quiz` 的实例（仅 standalone，embedded check 不独立成行）：

```
Artifact
  id, type=tool_quiz
  title
  knowledge_id?
  intent_source: declared | from_mistake | from_dream
  source: daily | final | dreaming | manual | mistake_variant | review_session
  source_ref?              # learning_item_id (final) / proposal_id (dreaming) / batch_id (review_session)
  tool_kind: 'quiz'
  tool_state: {
    question_ids: [string]
    session_meta?: { time_limit_seconds?, shuffle?: bool, ... }
  }
  ...
```

### 9.3 Answer / Judgment / UserAppeal

```
Answer
  id, question_id, learning_item_id?
  input_kind, content_md, image_refs[], vision_extracted?
  tags?: [string]
  submitted_at

Judgment                          # 不可变；同 answer_id 可有多条
  id, answer_id
  judge_kind, verdict, score
  feedback_md, evidence_json
  is_flexible_fallback, triggered_by?, prior_judgment_id?
  judged_by, judged_at, is_effective

UserAppeal
  id, judgment_id
  reason, appealed_at
  resolved_judgment_id?
```

### 9.4 Embedded check vs Standalone tool_quiz

| | Embedded check | Standalone tool_quiz |
| --- | --- | --- |
| 存储 | inline 在 `note_atomic.sections[].embedded_check.question_ids` | 独立 `Artifact` 行（type=tool_quiz） |
| 生命周期 | 跟 note section 1:1 | 独立（每日新生 / 用户保存 / review session） |
| 可重做 | 可重做（生 Answer + Judgment） | 可重做 |
| 可跨场景复用 | 否（绑死 note） | 是 |
| Artifact archived | 跟随 note | 独立归档 |

---

## 10. Task 注册

| Task | Provider/Model | 触发 | 备注 |
| --- | --- | --- | --- |
| `QuizGenTask` | Sonnet (+ batch 可选) | embedded check / daily / final / 用户主动 | 输出 `Question[]`；caller 决定包成 standalone Artifact 或 inline 进 note section |
| `JudgeRouter` | n/a | 每次答案提交 | 纯逻辑路由 |
| `JudgeExactTask` | n/a | exact judge | 字符串比对，无 LLM |
| `JudgeKeywordTask` | n/a | keyword judge | 关键词集合命中率，无 LLM |
| `JudgeSemanticTask` | Sonnet / Haiku | semantic judge | 单轮 structured output |
| `JudgeRubricTask` | Opus / Sonnet | rubric judge | 单轮 structured output，按 rubric_json 评分 |
| `JudgeStepsTask` | Sonnet | computation judge | 步骤验证 + 最终值匹配 |
| `JudgeMultimodalTask` | Opus / GPT-5.x (multimodal) | image 答案 + visual_complexity ≥ medium | 直接吃图，不走 vision pipeline |
| `JudgeFlexibleTask` | Opus / 顶级 reasoning | ai_flexible 兜底 | 显式 CoT + 完整上下文 |
| `VisionAnswerExtractTask` | 低成本视觉模型（CMMMU 选型） | 图片答案 → 文字（pipeline 路径） | 与 VisionExtractTask 共享 vision provider，输出 schema 不同 |

**实现注**: JudgeTask 系（exact/keyword/semantic/rubric/steps/multimodal_direct）有共同接口：

```typescript
interface JudgeTask {
  kind: JudgeKind
  needs_llm: boolean
  run(question: Question, answer: Answer): Promise<Judgment>
}
```

---

## 11. 与其他模块的衔接

| 模块 | 衔接方式 |
| --- | --- |
| [mistakes](mistakes.md) | `Judgment.verdict in [partial, incorrect]` 时创建 Mistake（含 question_id 引用 + wrong_answer + cause）。Appeal 翻盘撤销 Mistake (标 misjudged) |
| [learning-items](learning-items.md) | `quiz_pass` 路径走 Judgment 全对：所有关联 Question 的 effective Judgment.verdict == correct |
| [progress](progress.md) | Judgment.score 喂 base_mastery；按 question.knowledge_ids[] 分摊 |
| [notes](notes.md) | Embedded check inline 在 atomic.section[check].question_ids；Note 渲染时调 JudgeRouter |
| [lanes](lanes.md) | 每日 quiz / dreaming 题目推荐 / FSRS 复习 session 都生成 standalone tool_quiz Artifact |

**事件驱动 vs 同步**：Phase 1 用同步函数调用（JudgeRouter 直接触发 mistake 创建 + mastery 更新）。事件总线推到 Phase 2+ 如需要。

---

## 12. 关键数据流

### 12.1 用户提交文字答案（pipeline 路径）

```
User → POST /answer { content, question_id, [learning_item_id, tool_quiz_artifact_id] }
  ├─ Persist Answer (input_kind=text)
  ├─ JudgeRouter.dispatch(question, answer)
  │    └─ JudgeSemanticTask (or JudgeExactTask, etc.)
  │         └─ Judgment created (initial, is_effective=true)
  ├─ if 0.4 ≤ score ≤ 0.7:
  │    JudgeFlexibleTask
  │       └─ new Judgment (triggered_by=borderline)
  │       └─ mark old Judgment.is_effective=false
  ├─ if effective Judgment.verdict ∈ [partial, incorrect]:
  │    create Mistake { question_id, wrong_answer_md=answer.content_md,
  │                     source='quiz_answer', source_ref=judgment.id, ... }
  │    AttributionTask → fill Mistake.cause
  ├─ feed effective Judgment.score → progress (base_mastery delta)
  └─ return Judgment + feedback to user
```

### 12.2 用户提交图片答案

```
User → POST /answer { images[], question_id }
  ├─ Persist Answer (input_kind=image, image_refs)
  ├─ JudgeRouter.dispatch(question, answer)
  │    ├─ shouldUseDirectMultimodal(q, a)?
  │    │    YES (visual_complexity=medium/high or computation+handwritten)
  │    └─ JudgeMultimodalTask (Opus mm + image + prompt + reference)
  │         └─ Judgment created
  │
  │    OR (NO direct multimodal)
  │    ├─ VisionAnswerExtractTask(image_refs) → vision_extracted
  │    ├─ Update answer.vision_extracted
  │    └─ (走 § 12.1 同样的 text 路径)
  │
  ├─ ... (后续同 § 12.1)
```

### 12.3 用户申诉

```
User → POST /appeal { judgment_id, reason }
  ├─ Verify Judgment exists, is_effective=true, never appealed before
  ├─ Create UserAppeal
  ├─ Fetch context: { question, answer, user_history, prior_judgment }
  ├─ JudgeFlexibleTask(triggered_by='appeal', appeal_reason=reason, ...)
  │    └─ new Judgment (is_flexible_fallback=true, triggered_by=appeal,
  │                     prior_judgment_id set, is_effective=true)
  │    └─ mark old Judgment.is_effective=false
  ├─ if verdict changed:
  │    if old=[partial|incorrect] and new=correct:
  │       find Mistake by old judgment_id
  │       mark Mistake as misjudged (deleted_at + reason='appeal_overturned')
  │       reverse mastery contribution
  │    if old=correct and new=[partial|incorrect]:  # 罕见但保险
  │       create Mistake (same flow as § 12.1)
  │       feed mastery negative
  ├─ UserAppeal.resolved_judgment_id = new Judgment.id
  └─ return new Judgment + reasoning to user
```

---

## 13. 反馈与 partial credit

### 13.1 不同 judge_kind 的反馈格式

| Judge | feedback_md 模板 |
| --- | --- |
| exact | "正确答案：{ref}。你的答案：{user}。" |
| keyword | "命中关键词 {hit}/{total}：缺失 [{missing}]。" |
| semantic | AI 生成自然语言：抓住了什么 / 漏了什么 |
| rubric | 按每个 criterion 列：得分 + 评分依据 |
| steps | 步骤 i 正确 / 步骤 j 出错（具体哪步）+ 最终值是否对 |
| multimodal_direct | AI 自然语言反馈，可引用图中具体位置 |
| ai_flexible | 详细 CoT，最长格式 |

### 13.2 Partial credit 计算

- **fill_blank 多空**：每空独立 0/1，最终 score = 命中数 / 总数
- **rubric 多 criterion**：每项 weight × subscore，加权求和
- **short_answer (semantic + keyword)**：score = 0.7 × semantic_score + 0.3 × keyword_score
- **computation (steps)**：步骤命中率 × 0.6 + 最终值正误 × 0.4
- **其他**：单一分数，0~1

verdict 由 score 决定：

```
score >= 0.85   → correct
0.4 < score < 0.85  → partial
score <= 0.4    → incorrect
```

partial 也算"答错入错题本"，但 mistake.cause.partial=true，复习时可酌情处理（lapses 半计，见 [`mistakes.md`](mistakes.md) § 4.3）。

---

## 14. 文言文场景验证矩阵

Phase 1 启动后用文言文典型题型验证 5 种 judge_kind：

| 文言文题型 | Question kind | 验证 judge_kind | 备注 |
| --- | --- | --- | --- |
| 解释加点字 | fill_blank | exact + keyword | 实词意义有标准答案，多义词靠 keyword 兜 |
| 翻译句子 | translation | semantic | 多种合理表达，semantic 必须能识别 |
| 概括段意 | short_answer | semantic + keyword | 抓核心信息 |
| 主旨概括 / 鉴赏分析 | essay (短) | rubric | 多维度评分（中心 / 结构 / 论证） |
| 用户对翻译判错申诉 | (任意) | ai_flexible | 验证兜底路径 |

5 条都 working = `tool_quiz` 子系统 validated。**Phase 1 不上 multimodal_direct 和 steps**——文言文场景没图、没计算。

---

## 15. Phase 路线（tool_quiz 子集）

### Phase 1（含 tool_quiz 骨架 + embedded check）

- [ ] Schema: Question / Answer / Judgment / UserAppeal
- [ ] Artifact 表加 type=tool_quiz 行支持（standalone）
- [ ] note_atomic.sections[].embedded_check.question_ids 字段（embedded inline）
- [ ] QuizGenTask（参数化，target='embedded' | 'standalone'）
- [ ] JudgeRouter（路由逻辑）
- [ ] JudgeExactTask / JudgeKeywordTask / JudgeSemanticTask（基础 3 种）
- [ ] JudgeFlexibleTask + UserAppeal 流程（兜底必须 Phase 1 就有）
- [ ] Embedded check 嵌入 atomic note
- [ ] Mistake 创建事件（incorrect / partial → mistake，appeal 翻盘撤销）
- [ ] mastery 反馈喂 base_mastery
- [ ] feedback_md 模板（5 种 judge_kind 各一份）
- [ ] partial credit 计算（fill_blank 多空 + short_answer 加权）

### Phase 2（standalone tool_quiz + 高级 judge + 多模态）

- [ ] **Standalone tool_quiz Artifact 完整支持**（每日 quiz / final quiz / 用户存的模拟卷）
- [ ] **Review session tool_quiz**（FSRS 到期错题 → 临时 standalone）
- [ ] JudgeRubricTask（rubric 评分）
- [ ] JudgeStepsTask（步骤验证）
- [ ] JudgeMultimodalTask（direct multimodal）
- [ ] VisionAnswerExtractTask（pipeline 路径）
- [ ] visual_complexity 路由
- [ ] 每日 quiz 集成 FSRS（dreaming 调度）
- [ ] 申诉接受率指标（监控判定质量）
- [ ] 判定一致性 eval（同 Q+A 多次判方差）

### Phase 3+

- [ ] 引入新 tool_kind（drill / visualizer / simulator 等），抽出通用 Tool interface
- [ ] Voice input
- [ ] 论述题深度评分（多 pass + self-consistency）
- [ ] 申诉前自动 sanity check（避免明显误判进入申诉队列）

---

## 16. 模块特定的待决策

- 申诉是否限次：默认每 Judgment 最多 1 次（已定）
- borderline 阈值是否动态：默认统一 0.4~0.7（runtime 调）
- 同一题多次答（学习中反复练）：每次新建 Answer，旧 Answer 保留全部历史（已定）
- Embedded check 的题是否纳入主 question 库：默认是（可被 daily quiz 重抽，但 source 标识保留 'embedded'）
- 用户标注 visual_complexity 优先 vs AI 推断：题目入库时 AI 自动推断，用户可在题目页 override
- Standalone tool_quiz 的 retention（用户存的模拟卷归档策略）— 默认久未访问 90 天归档（沿用 maintenance 默认）
- partial credit 的 verdict 阈值（0.4 / 0.85）：runtime 调
- Rubric 多次评分的一致性：Phase 3+ 加 self-consistency 检查
