# 错题管理

> 见 [架构基础](../architecture.md) 了解 `Mistake` / `Question` schema、FSRS state 和 AI 任务层。
> 题面统一在 `Question` 表（见 [`quiz.md`](quiz.md)），Mistake 只记「做错事件 + 复习态 + 错因」。

---

## 1. Mistake 与 Question 的关系

**核心 reframe**：题面只在 `Question` 表里存一份，`Mistake` 是「这道 Question 用户做错过」的事件记录 + 复习态。

```
Question (统一题库)
  · 题面、参考答案、rubric、知识点、难度
  · 来源：quiz_answer / manual / vision_capture / mistake_variant / dreaming / ...
  ↑ 引用
Mistake (事件 + 复习态)
  · question_id (必须)
  · wrong_answer_md? (用户当时的错答，可省略)
  · source / source_ref (区分错题怎么进来的)
  · cause (错因分析)
  · fsrs_state (复习调度)
  · variants[] (变式题，每条引用另一个 question_id)
```

**好处**：
- 题面去重：同一道题用户在不同时间错过 = 一个 Question + 多个 Mistake（或者一个 Mistake 多次复习失败）
- 复习引擎统一：复习 = 用 [`tool_quiz`](quiz.md) 答 question_id 对应的题
- 变式题就是新 Question 实例，跟主题库平级（不是 Mistake 私有数据）
- Quiz 答错与手动录入路径一致：都先创建 Question → 绑 Mistake

---

## 2. 录入入口（四种）

每种入口都遵循同一管线：**先建 Question，再绑 Mistake**。

### 2.1 Quiz 答错（自动）

```
User 提交 Answer → JudgeRouter → Judgment(verdict ∈ [partial, incorrect])
   ↓ 自动触发
Mistake.create({
  question_id: judgment.answer.question_id,    // Question 已存在，直接引用
  wrong_answer_md: judgment.answer.content_md,
  source: 'quiz_answer',
  source_ref: judgment.id,
  cause: AttributionTask.run(question, answer, judgment),
})
```

申诉翻盘时 soft delete 该 Mistake（`delete_reason='misjudged'`）。

### 2.2 拍照 / 截图录入（半自动）

```
User 上传图片 → VisionExtractTask → 候选题面 + 参考答案 + 选项 + 类型推断
   ↓ 用户确认 / 修正
Question.create({
  prompt_md, reference_md, kind, knowledge_ids, ...
  source: 'vision_capture'
})
   ↓
User 标注「我做错过」+ 可选填错答
   ↓
Mistake.create({
  question_id, wrong_answer_md?,
  source: 'vision_capture',
  source_ref: null
})
```

VisionExtractTask 输出包含 `multi_question: bool` 和 `question_blocks[]`——一张图含多题时分别建多个 Question + 多个 Mistake。

### 2.3 手动粘贴（纯文本 / Markdown）

```
User 粘贴题面 + 参考答案
   ↓
Question.create({source: 'manual'})
   ↓
Mistake.create({source: 'manual', source_ref: null})
```

简洁路径，无 AI 介入题面识别（只跑后续 AttributionTask）。

### 2.4 从 artifact 或会话反向标记

```
User 在 note 阅读 / 会话过程中点「这个我会错」
   ↓ 上下文已包含相关概念
Question.create({source: 'reverse_mark', source_ref: artifact_id})
   ↓
Mistake.create({source: 'reverse_mark', source_ref: artifact_id})
```

适合用户主动标记"这块我容易出错"——尚未真错，但提前入复习池。

---

## 3. AI 处理

每条 Mistake 创建时同步必跑：

### 3.1 AttributionTask（归因）

输入：Question + Mistake.wrong_answer_md (如有) + 用户历史

输出 → `Mistake.cause`：
```
{
  primary_category: concept | calculation | reading | knowledge_gap | ...
                    (扩展分类详见模块特定待决策)
  secondary_categories?: [...]   // 多因素
  ai_analysis_md: 自然语言分析「为什么会错」
  user_notes?: 用户事后补充
  partial?: bool
}
```

### 3.2 知识点挂载

输入：Question.knowledge_ids[] + Mistake.cause + 用户在该知识点的历史

输出 → `Mistake.knowledge_ids[]`：可能与 `Question.knowledge_ids[]` 不完全一致——错过反映的具体盲点（比如题目挂"导数"，但用户错在"链式法则"，Mistake 单挂"链式法则"）。

### 3.3 LearningItem 触发判断

错题暴露的知识点缺口够明显时（mastery<0.3 或近期反复错），自动创建 LearningItem（见 [`learning-items.md`](learning-items.md)）。

### 3.4 异步：变式题生成

夜间 batch 跑 `VariantGenTask`：
- 输入：原 Question + Mistake.cause（针对错因生成变式）
- 输出：每条变式是新 `Question` 实例（`source: mistake_variant`，`source_ref: original_question_id`）
- 写入：`Mistake.variants[].push({question_id, status: 'draft'})`
- 用户做对一次 → status=`active`，进复习池
- 双 pass + draft 状态防止 AI 幻觉变式直接喂复习

详细见 [模块特定的待决策 § 变式题深化]。

---

## 4. 复习调度

应试场景下 **FSRS** 比 SM-2 更合适。每条 Mistake 持有 `fsrs_state`。

### 4.1 复习 = 通过 tool_quiz 答 Question

复习不是独立机制，是 `tool_quiz` 的一种 source：

```
FSRS 到期 Mistake 集合 (今日 N 条)
  ↓
生成临时 standalone tool_quiz Artifact (source='review_session')
  ↓ tool_state.question_ids = [m1.question_id, m2.question_id, ...]
User 答 → JudgeRouter → Judgment
  ↓ Judgment 反喂回 Mistake.fsrs_state
FSRS 更新 (correct → 加大 interval；incorrect → lapses+1, 重置 interval)
```

复习 session 的 tool_quiz Artifact 用完归档（`source: review_session`），不污染主题库。

### 4.2 复习 session 的多种触发

- **FSRS 到期自动**：每天 dreaming 夜间任务挑出今日到期 Mistake，生成 review tool_quiz
- **每日 quiz**：每日 quiz 优先抽到期错题（见 [`lanes.md`](lanes.md)）
- **用户主动**：用户在错题本点「我现在想复习」→ 生成临时 tool_quiz
- **Note embedded check 错题反向**：embedded check 答错入错题，下次到期由 FSRS 调度

### 4.3 partial credit 错题的复习策略

`Judgment.verdict='partial'` 也算"答错"入复习池，但 FSRS 更新策略偏温和：
- 不重置 interval，但 lapses+0.5（半计）
- `Mistake.cause.partial = true` 标记，复习时显示「上次部分正确」

---

## 5. 生命周期状态

```
draft       vision/手动录入待用户确认 (题面识别可能不准)
  ↓
active      在复习池
  ↓
resting     掌握中：retrievability > 0.95 持续 ≥3 次复习
  ↓
archived    久未触达 (90 天默认) / 用户主动 / 课标过期
  ↓
deleted     soft delete (30 天可恢复)
```

| 转换 | 触发 |
| --- | --- |
| draft → active | 用户确认 / AI 高置信录入 |
| active → resting | FSRS retrievability >0.95 持续 ≥3 次复习 |
| resting → active | retrievability 衰减回到 <0.85 |
| active/resting → archived | maintenance lane 提议 + 用户接受 |
| archived → active | 用户手动 unarchive / dreaming 主动拉回 |
| 任意 → deleted | 用户删 / appeal 翻盘 / 重复合并 |

---

## 6. 搜索 / 浏览维度

错题本的过滤维度（UI 提供）：
- 知识点（filter by knowledge_ids）
- 错因（filter by cause.primary_category）
- 错频（错过 N 次以上）
- 时间（最近 / 一周内 / 一月内）
- 学科（domain）
- 状态（active / resting / archived）

---

## 7. 与其他模块的接口

| 接口 | 方向 | 说明 |
| --- | --- | --- |
| Quiz answer 自动建 Mistake | quiz → mistakes | `Judgment.verdict ∈ [partial,incorrect]` |
| 申诉翻盘撤销 Mistake | quiz → mistakes | soft delete + `delete_reason='misjudged'` |
| `link_mistake_to_node` | mistake → knowledge | AttributionTask 输出挂载 |
| 触发 LearningItem | mistake → learning-items | 缺口明显时 |
| FSRS retrievability 喂 base mastery | mistake → progress | 自动驱动 |
| 反向 propose 更新 note pitfall | mistake → notes | living note 触发器 |
| Maintenance: 删 / 重置 / 归档 | maintenance → mistake | 走 MaintenanceSuggestion |
| 复习 = tool_quiz session | mistake → quiz | source='review_session' |

---

## 模块特定的待决策

### 已定

- 视觉模型选型 baseline → CMMMU + MMMU + 自定义 10~20 张样本
- 变式题质量保证 → 双 pass + draft 状态
- partial credit 错题的复习策略 → 进 FSRS，但 lapses+0.5 温和扣分
- **Mistake 与 Question 解耦** → 题面统一在 Question；Mistake 只记事件+复习态+错因（v0.7 reframe）

### 待 push

- 错因分类扩展（当前 4 类不够，建议 6+ 类 + secondary 标签支持）
- 变式题深化（生成维度 / 双 pass 验证 / draft→active 触发条件 / 防"错题繁殖"）
- 录入流程的具体管线（vision 多题切分、AI 询问 vs 自动决策 question kind）
- 错题搜索 UX 细节
