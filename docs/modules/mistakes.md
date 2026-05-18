# 错题管理

> 见 [架构基础](../architecture.md) 了解 `learning_record` / `event` / `question` / `material_fsrs_state` schema、FSRS state 和 AI 任务层。
> 题面统一在 `question` 表（见 [`quiz.md`](quiz.md)），「错题」是 event 流的一种视图。
> 用户活动上下文入口详见 [`records.md`](records.md)；错题是 `LearningRecord(kind='mistake')`。

---

## 0. 数据模型现状（2026-05-17，post-1c.1 Step 9）

> ⚠️ 下面 §1–§6 的 `Mistake` / `mistake_id` / `Mistake.cause` 等命名是 Phase 1 sketch 期写的，**实际表已 DROP**（1c.1 Step 9）。整篇 doc 的"错题"概念在落地实现里是 event 流的一个视图。读完本节心里替换即可，后续段落保留作为概念语义参考。

**2026-05-18 目标存储**：

| 概念 | 实际存储 | 备注 |
|---|---|---|
| 用户可见错题记录 | `learning_record(kind='mistake', activity_kind='attempt', origin_event_id=attempt_event_id, question_id, attempt_event_id, payload.wrong_answer_md, knowledge_ids)` | 用户答题活动物化出的一种 record kind |
| 答错事实 / mastery signal | `event(action='attempt', subject_kind='question', outcome='failure')` | 一行 event = 一次答错 |
| 做对事实 / mastery signal | `event(action='attempt', subject_kind='question', outcome='success')` | 一行 event = 一次确认做对；默认不是错题 record |
| 题面 | `question` | 与变式题、worked example 共享题库 |
| 错因 | AI `judge` event 或 user `experimental:user_cause` event，均 chain 到 `attempt_event_id` | 用户优先 |
| 复习状态 | `material_fsrs_state(subject_kind='question', subject_id=<qid>)` | 一行 / 题 |

拍照导入一页作业时，错题和做对题都应从 `question_block` 物化为 `question + attempt event`。
区别是：`outcome='failure'` 会额外创建 `learning_record(kind='mistake')`；`outcome='success'`
只作为学习表现信号，除非用户/agent 标记这题值得保留，才额外创建
`learning_record(kind='worked_example')`。

**当前已实现存储（迁移前）**：

| Phase 1 sketch 词 | 实际存储 | 备注 |
|---|---|---|
| `Mistake(question_id, wrong_answer_md, source, …)` | `event(action='attempt', subject_kind='question', outcome='failure', payload={answer_md, answer_image_refs, referenced_knowledge_ids})` | 一行 event = 一次答错 |
| `Mistake.cause`（user 手填或 AI 归因） | AI: `event(action='judge', subject_kind='event', caused_by=<attempt id>, payload.cause)`。<br>User: `event(action='experimental:user_cause', subject_kind='event', caused_by=<attempt id>, payload={primary_category, user_notes})` | 用户优先 |
| `Mistake.fsrs_state` | `material_fsrs_state(subject_kind='question', subject_id=<qid>, state, due_at, last_review_event_id)` | 一行 / 题 |
| `Mistake.source = 'quiz_answer' / 'manual' / 'vision_*' / 'reverse_mark'` | 当前只跑 `manual` (POST /api/mistakes) + `vision_single` / `vision_paper`（OCR → import）；`quiz_answer` 自动管线 + `reverse_mark` 留到 Phase 2 quiz 时再展开 | |
| `Mistake.variants[]` / 变式繁殖 | Phase 2 Task #17 ✅：`variant_gen` pg-boss handler 由 `attribution_followup` 链路触发，写 `question(source='mistake_variant', draft_status='draft', variant_depth, root_question_id, parent_variant_id)`。MVP 单 pass（无 VariantVerifyTask），每个 parent 单变式 cap，3 层防繁殖（depth≤1 / variant 不再生变式 / cause∈{carelessness,time_pressure,other} 跳过）。UI 0 触点（变式仅在题库存在，复习引擎自动捞）。详见 §3.4 | |
| `judgment` 表 + `JudgeRouter` | DROPped（1c.1 Step 1.4）；判分走 `event(action='judge')` 替代 | |
| `mistake.deleted_at` soft-delete | 未实现（event 流没有 retraction 机制）；申诉翻盘 Phase 1d 再设计 | |

**用户面文案保留**："错题"在 UI / wire 上仍是错题（`GET /api/mistakes?...` 返回 mistake-shape JSON），仅内部存储换了。

**实际录入入口（v0.1 上线）**：
- `manual` —— POST /api/mistakes（手填题面 + 错答 + 知识点 + 可选 cause）
- `vision_single` —— 1 张图 → /api/assets → /api/ingestion → /api/ingestion/[id]/extract → SSE → /api/ingestion/[id]/blocks → /api/ingestion/[id]/import
- `vision_paper` —— 1-5 张图，同上 + 跨页 block 合并 UI（vision 1c.2.C）

---

## 1. Mistake 与 Question 的关系

**核心 reframe**：题面只在 `Question` 表里存一份，`Mistake` 是「这道 Question 用户做错过」的事件记录 + 复习态。

```
Question (统一题库)
  · 题面、参考答案、rubric、知识点、难度
  · 来源：quiz_answer / manual / vision_single / vision_paper / reverse_mark / mistake_variant
  · 变式系列：variant_depth / root_question_id / parent_variant_id
  ↑ 引用
Mistake (事件 + 复习态)
  · question_id (必须)
  · wrong_answer_md? (用户当时的错答，可省略)
  · source / source_ref (区分错题怎么进来的)
  · cause (错因分析，10 类 primary + secondary[])
  · fsrs_state (复习调度)
  · variants[] (变式题，每条引用另一个 question_id)
  · variants_generated_count / variants_max (防错题繁殖)
```

**好处**：
- 题面去重：同一道题用户在不同时间错过 = 一个 Question + 多个 Mistake（或者一个 Mistake 多次复习失败）
- 复习引擎统一：复习 = 用 [`tool_quiz`](quiz.md) 答 question_id 对应的题
- 变式题就是新 Question 实例，跟主题库平级（不是 Mistake 私有数据）
- Quiz 答错与手动录入路径一致：都先建 Question 再绑 Mistake

---

## 2. 录入入口（五种）

每种入口都遵循同一管线：**先建 Question，再绑 Mistake**。学科与知识点一律由 AI 从内容推断（不让用户预选学科）。

### 2.1 Quiz 答错（自动）

```
User 提交 Answer → JudgeRouter → Judgment(verdict ∈ [partial, incorrect])
   ↓ 自动触发
Mistake.create({
  question_id: judgment.answer.question_id,
  wrong_answer_md: judgment.answer.content_md,
  source: 'quiz_answer',
  source_ref: judgment.id,
  cause: AttributionTask.run(question, answer, judgment),
})
```

申诉翻盘时 soft delete 该 Mistake（`delete_reason='misjudged'`）。

### 2.2 单题拍照（vision_single，Phase 1）

最简单的 vision 录入路径：用户拍一张照片，里面就一道题。

```
User 拍单题图片 → VisionExtractTask → 候选题面 + 参考答案 + 选项
                                     + AI 推断学科 / 题型 / 知识点
   ↓ 一击确认页（用户扫一眼必审字段）
Question.create({source: 'vision_single', ...})
   ↓
User 标注「我做错过」+ 可选填错答
   ↓
Mistake.create({source: 'vision_single', ...})
```

**必审字段**：题面、参考答案、关联知识点（影响 mastery 计算）。其他自动通过。

### 2.3 卷子拍照 / 批改识别（vision_paper，Phase 1.5）

用户做完一张卷子（老师批改过 OR 自己核对了答案标对错）→ 拍 1~N 张照片 → 系统自动识别多题 + 批改痕迹 + 用户答案。

**收益**：30 题的卷子从 30 次单题录入 → 1 次拍照 + 1 次审核。

```
User 连拍 1~N 张卷子（含批改痕迹）
   ↓ 多张图作为一次 vision call 输入（跨页大题自然关联）
VisionExtractTask 输出：
  - paper_meta { subject_domain_inferred, has_grading_marks }
  - question_blocks[]
    每条 block: { prompt_md, user_answer_md?, reference_md?,
                  grading_marks { kind: correct|incorrect|partial|unmarked, score_lost? },
                  verdict_inferred, kind_inferred, knowledge_inferred[],
                  visual_complexity, confidence }
   ↓
卷子审核页（默认仅展开 verdict ∈ [incorrect, partial] 的题，对的折叠）
   ↓ [批量录入错题]
N × Question.create({source: 'vision_paper', ...})
N × Mistake.create({source: 'vision_paper', source_ref: paper_session_id})
   ↓ 后台
N × AttributionTask 走 batch（夜间）
```

**Prompt 要点**（影响识别质量）：
- 一次性吃多图，AI 自己识别 page 顺序、跨页大题、共享 passage
- 识别**任何形式批改痕迹**（红笔、铅笔、电子标注、勾叉、扣分数字、批语等）—— 不在 schema 里区分类型，全统一到 `grading_marks.kind`
- 没有批改痕迹时 verdict_inferred=`unknown`，审核页让用户逐题点对错或上传参考答案让 AI 重判

**默认行为**：
- 仅 verdict ∈ [incorrect, partial] 的题创建 Mistake；对的题不入错题（避免错题本污染）
- 所有题（含对的）都进 Question 题库（题库丰富）
- 用户可勾选「保留为模拟卷」→ 整套 Question 包成 standalone `tool_quiz` Artifact，未来可重刷

**图片存储**：vision_paper 单次上传 1~N 张图片（每张 2-5MB），用户审核完批量录入时图片必须可重复读取。卷子图片走 Cloudflare R2 持久化（worker `[[r2_buckets]]` binding `IMAGES`，PR 1 已加 wrangler.toml 占位字段）；DB 中 `Mistake.wrong_answer_image_refs[]` / `Answer.image_refs[]` 持的是 R2 object key。client 上传时走 worker `POST /api/upload/image` → 写 R2 → 返 r2 key（实际 endpoint 落地推 Phase 1.5 实施时）。

### 2.4 手动粘贴（manual）

```
User 粘贴题面 + 参考答案
   ↓
Question.create({source: 'manual'}) - AI 自动判断学科 / 题型 / 知识点
   ↓
Mistake.create({source: 'manual', source_ref: null})
```

无 AI 介入题面识别（已结构化文本输入），AttributionTask 仍跑。

### 2.5 从 artifact 或会话反向标记（reverse_mark）

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
  primary_category:                # 10 类（详见下表）
    concept | knowledge_gap | calculation | reading | memory
    | expression | method | carelessness | time_pressure | other
  secondary_categories?: [<same enum>]   # 多重原因（一道题常多因）
  ai_analysis_md                    # 自然语言分析「为什么会错」
  user_notes?                       # 用户事后补充
  partial?: bool
  confidence?: float                # AI 对 primary 的信心 (0~1)
  user_edited?: bool                # 用户改过后 AI 不再覆盖
}
```

**10 类错因 taxonomy**：

| 类 | 含义 | 区别 |
| --- | --- | --- |
| `concept` | 对核心概念理解有偏差 | 有概念但边界模糊 / 抽象误解 |
| `knowledge_gap` | 该知识点完全不知道 / 没学过 | 根本不知 vs 知道但偏 |
| `calculation` | 计算执行错误 | 思路对，算错 |
| `reading` | 审题失误 | 没理解题目要问什么 |
| `memory` | 记错具体内容 | 人名 / 年份 / 公式 / 定义字面 |
| `expression` | 思路对但表达不准确 | 语言组织 / 术语混淆 |
| `method` | 解题方法选错 | 宏观思路错（vs concept 局部理解错） |
| `carelessness` | 粗心 / 笔误 / 漏看 | 机械错（vs calculation 计算能力问题） |
| `time_pressure` | 时间不够 | 限时场景；本来会做 |
| `other` | 以上都不准 | confidence < 0.6 时走这个 + ai_analysis_md 自由描述 |

**AI 推断逻辑**：
- 看 wrong_answer 跟 reference 的差异类型
- 看用户在该知识点的历史（初次接触？多次错？）
- 看错题的 cause keywords（题面 / 用户答案中的线索）
- confidence < 0.6 → 走 `other` + 详细 ai_analysis_md

**Secondary categories**：一道题常多重原因，secondary_categories[] 收尾。例：

```
主 calculation, 副 [carelessness]      算错时还抄错符号
主 concept, 副 [method]                概念不清导致选错方法
主 reading, 副 [knowledge_gap]         看错题 + 该点也不熟
```

**用户编辑**：
- 错题详情页可改 primary_category（dropdown）+ 加/删 secondary_categories（tag）+ 写 user_notes
- 修改后 `user_edited=true`，AI 不再覆盖（除非用户清空让 AI 重新归因）

**失败兜底**：AttributionTask 失败不阻塞 Mistake 创建——cause 留空标"待归因"，后台重试 ≤3 次；仍失败进"待人工归因"队列让用户手动写或忽略。

### 3.2 知识点挂载

输入：Question.knowledge_ids[] + Mistake.cause + 用户在该知识点的历史

输出 → `Mistake.knowledge_ids[]`：可能与 `Question.knowledge_ids[]` 不完全一致——错过反映的具体盲点（比如题目挂"导数"，但用户错在"链式法则"，Mistake 单挂"链式法则"）。

### 3.3 LearningItem 触发判断

错题暴露的知识点缺口够明显时（mastery<0.3 或近期反复错），自动创建 LearningItem（见 [`learning-items.md`](learning-items.md)）。

### 3.4 异步：变式题生成（双 pass + 防"错题繁殖"）

**v0 状态（Task #17，2026-05-17）**：MVP **单 pass** 已上线 —— `attribution_followup` 写完 judge 后入队 `variant_gen`（pg-boss），worker 拉 `VariantGenTask`（mimo-v2.5-pro）出一道 `source='mistake_variant'`，`draft_status='draft'`，`variant_depth=parent+1` 的 `question`。VariantVerifyTask 双 pass、variants_max 计数表、UI 显式列表都留待 Phase 3 跑数据后决定。

变式 Question 跟主题库平级——`source: mistake_variant`，可被 daily quiz 抽，也可入 standalone tool_quiz。

#### 3.4.1 生成维度（针对 cause 类型）

`VariantGenTask` 的 prompt 收 `Mistake.cause` 作为关键输入，按错因类型出针对性变式：

| Cause 类型 | 变式策略 |
| --- | --- |
| `concept` | 同概念不同语境 / 反向考查（验证概念边界） |
| `knowledge_gap` | 补充该知识点的多种典型变体 |
| `calculation` | 改数据 + 留下相同陷阱（验证计算稳定性） |
| `reading` | 改提问方式 + 加干扰信息 |
| `memory` | 不同表述测同一记忆点 |
| `expression` | 同题让用户重写答案，重点检查表达 |
| `method` | 提示备选方法 + 同类型题 |
| `carelessness` | 标"做完检查"提示，**不出 conceptually 难变式**（避免噪音） |
| `time_pressure` | 同类题 + 时间分配提示 |
| `other` | AI 根据 ai_analysis_md 自由生成 |

#### 3.4.2 双 pass 验证

```
Pass 1  VariantGenTask    → 候选变式 (新 Question 实例，draft_status='draft')
                            provider: Sonnet + batch
Pass 2  VariantVerifyTask → 验证（不同 model，如 Opus + batch）：
                            · AI 自己尝试解一遍，是否得到 reference_md
                            · 题面是否有歧义
                            · 难度是否符合标记
                            · 是否真的考查了目标知识点 + 错因
                            输出: { is_valid, failure_reasons[],
                                    cause_targeting: 'good'|'weak'|'mismatch' }
不通过 → variants[].status = 'broken'，不入复习池，记录失败原因
通过   → variants[].status = 'draft'，等用户首次做对转 'active'
```

成本 +50%（双 pass + 不同 model），但显著降低"错答案进复习池"风险。

#### 3.4.3 draft → active / broken 触发规则

```
首次答 verdict=correct (含申诉翻盘)        → status='active' (进复习池)
首次答 verdict=incorrect                   → 保持 'draft'
                                            (不立刻入复习池，等用户再答确认)
首次答 verdict=partial                     → 保持 'draft' + Mistake.cause.partial
用户主动标"题面 / 答案有问题"               → status='broken'
用户主动 dismiss                            → status='dismissed'
变式 active 后再被错答                      → 跟普通错题一样进新 Mistake，
                                            但**该新 Mistake 不再生变式**（防繁殖根）
```

#### 3.4.4 防"错题繁殖"三层防御

最大风险：**错变式 → 又生变式 → 又错 → 无限循环**。三层防御层层堵：

**1) `variant_depth` 上限：变式不超过 2 代**

```
Question
  + variant_depth: int          // 0=原题，1=一代变式
  + root_question_id?: string
  + parent_variant_id?: string

VariantGenTask 触发条件:
  if root_question.variant_depth >= 2:
    SKIP   # 不再扩展第三代
```

实操：原题 (depth=0) 错了能生 depth=1，depth=1 的变式错了**不再生 depth=2**。

**2) `variants_max` per Mistake：默认 3 条上限**

```
Mistake
  + variants_generated_count: int (默认 0)
  + variants_max: int              (默认 3)
```

每条 Mistake 默认最多生 3 条变式，达上限不再触发 VariantGenTask。

**3) 变式 Mistake 不再生变式：链终止**

```
if mistake.from_judgment_id and 
   question.source == 'mistake_variant':
  do NOT trigger VariantGenTask
```

变式题答错产生的 Mistake 不会再触发新的变式生成——这是繁殖链的最终终止。

#### 3.4.5 用户主动 vs 自动触发

| 触发 | 条件 | 限制 |
| --- | --- | --- |
| 自动（默认） | Mistake 创建后 dreaming 夜间 batch | variants_max=3 / variant_depth≤2 |
| 用户主动 | 错题页"再来几道类似的"按钮 | **绕过 variants_max**（用户明确意图） |

#### 3.4.6 质量监控指标（dreaming 周报输出）

跑一段时间后看：
- **变式接受率** = `active` 数 / 总生成数（应 >70%）
- **broken 率** = `broken` 数 / 总生成数（应 <15%，否则 prompt 有问题）
- **单 active cost** = 总成本 / active 数
- **错因匹配度** = VerifyTask 标 `cause_targeting='good'` 比例

低于阈值触发"调 prompt"或"换 verify model"。

#### 3.4.7 UI 展现

错题本展示原 Mistake 时，下面列 variants：每条状态（draft / active / broken / dismissed）+ 上次结果。点 broken 标记可看 VerifyTask 的 `failure_reasons[]`，让用户判断要不要手动修。

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

### 4.4 cause 类型差异化（Phase 2）

不同错因的复习权重 / mastery 衰减不同：

| Cause | 复习频率 | mastery 影响 | 理由 |
| --- | --- | --- | --- |
| `knowledge_gap` | 高 | 大 | 基础没打好 |
| `concept` | 高 | 大 | 概念不清反复错 |
| `calculation` | 中 | 中 | 需要练但非"理解"问题 |
| `reading` | 中 | 中 | 审题习惯训练 |
| `memory` | 中 | 中 | 间隔重复主战场 |
| `method` | 中 | 中 | 见多识广 |
| `expression` | 低 | 小 | 表达细节不需多练 |
| `carelessness` | 低 | 小 | 提醒就够，不需难题练 |
| `time_pressure` | 低 | 小 | 训练速度 ≠ 训练知识 |
| `other` | 中 | 中 | 默认 |

具体权重 Phase 2 跑数据后调。

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
- **错因**（filter by cause.primary_category，10 类 + secondary[]）
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
| **cause 维度喂周报** | mistake → progress | 周复盘按 cause 分类统计 |
| 反向 propose 更新 note pitfall | mistake → notes | living note 触发器 |
| Maintenance: 删 / 重置 / 归档 | maintenance → mistake | 走 MaintenanceSuggestion |
| 复习 = tool_quiz session | mistake → quiz | source='review_session' |
| 卷子另存为 standalone tool_quiz | mistake (vision_paper) → quiz | 用户勾选保留为模拟卷 |
| 变式题入主题库 | mistakes → quiz | Question.source='mistake_variant' |

---

## 模块特定的待决策

### 已定

- 视觉模型选型 baseline → CMMMU + MMMU + 自定义 10~20 张样本
- 变式题质量保证 → 双 pass + draft 状态
- partial credit 错题的复习策略 → 进 FSRS，但 lapses+0.5 温和扣分
- Mistake 与 Question 解耦 → 题面统一在 Question；Mistake 只记事件+复习态+错因
- 学科自动判断 → 由 vision pipeline / AttributionTask 推断，不让用户预选
- 批改识别（vision_paper）→ Phase 1.5 实现
- 录入流程必审字段 → 题面 / 参考答案 / 关联知识点；其他 AI 自动
- AttributionTask 失败兜底 → Mistake 创建不阻塞，后台重试 + 待人工归因队列
- 变式题生成维度 → 按 cause 类型出针对性变式（10 类各对应策略）
- 防"错题繁殖"三层防御 → variant_depth ≤ 2 + variants_max=3 + 变式 Mistake 不再生变式
- 变式 draft → active 触发 → 首次 verdict=correct（含申诉翻盘）
- broken_variant 处理 → VerifyTask 不通过 / 用户主动标
- 用户主动触发"再来几道"绕过 variants_max
- **错因分类 10 类**（concept / knowledge_gap / calculation / reading / memory / expression / method / carelessness / time_pressure / other）
- **secondary_categories[] 多重原因支持**
- **cause confidence 字段** → 低信心走 `other` + 自由描述
- **cause user_edited 字段** → 用户编辑后 AI 不再覆盖
- **复习权重 / mastery 衰减按 cause 差异化**（Phase 2 实施，权重表已定方向）

### 待 push

- 错题搜索 UX 细节（多维过滤组合、保存的过滤条件、错频可视化）
