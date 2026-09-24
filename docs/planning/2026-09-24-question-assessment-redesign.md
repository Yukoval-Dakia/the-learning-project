# 真实题目驱动的题目存储与判分重设计

日期：2026-09-24 · 关联：YUK-1038 · **状态：owner 认可模型方向；全量迁移的 source-only implementation grounding 已完成，未执行实施/迁移**

> **Owner 最新裁决（优先于下文早期建议）**：「不错的模型。不分批了，要上就全量迁移，支持任意题目。详细的 impl grounding 做一轮。」因此 §5.2 分阶段产品切换与 §8 LIGHT/LIGHT-1 推荐不再是执行方向；保留为决策历史。现目标为全部来源/消费面/历史数据纳入统一契约，一次性产品切换。内部工程依赖、离线迁移演练和回滚准备不等于分批上线。任意题目需要通用表示、作答证据和评分契约，不承诺所有输入都能无歧义自动给分。全量迁移不自行解释为重新判分全部历史作答；其语义须本轮 grounding 明确。新工作计划见 [implementation grounding](2026-09-24-question-assessment-implementation-grounding.md)。

本轮 owner 要求：「你亲自调研一圈 realworld 题目类型，重新设计题目存储与判分系统。」
本文取代先前决策网页中将 YUK-1038 称为“终态/已锁定设计”的表述；此前已确认的选择题确定性判分、非选择题录入时规划判分、Jev 不可用/低置信转高级 LLM 的意图保留。**把所有数学填空直接分配给 Jev 不再作为已验证方案**，原因见 §3，变更须 owner 确认。

不涉及本轮实施、付费模型测试、生产数据修改或部署。YUK-310 独立 worktree 的交付仍待 review，不因本研究宣称完成。

## 研究任务与证据边界

- [x] 主会话亲自读取官方试题图片、评分 PDF、标准正文，区分来源事实和设计推论。
- [x] explorer 核查当前存储、solo 提交和 judge snapshot；未完整追通的生产/复判路径明确列为实施前 gate。
- [x] librarian 核查 Jev 官方资料；主会话复读官方 API/概念正文及 jaggedness 页面。
- [x] 汇总本提案。
- [x] 独立架构复核并归并结论（source-grounded，见 §6 与文末「独立复核处置」）。
- [x] Linear capture：parent 已在 YUK-1038（Backlog）留言本次修正；无重复 issue。
- [x] Owner 认可模型方向并裁决全量迁移，拒绝 LIGHT-1 分批上线。
- [x] 完成全量 implementation grounding，收敛历史映射、主要消费者、统一切换/回滚和验收方案；产品裁决与运行证据仍开放，不执行数据迁移或部署。

这是有代表性的横切样本，不是所有国家/科目题型的穷尽普查；官方样卷也不等于本应用已具备相应自动评分准确率。未进行 Jev 或高级 LLM actual-output 评测。

## 1. 真题告诉我们：不是一道题一个字符串，再选一个模型

### 1.1 真实样本 → 必须表达的规则

| 官方样本与定位 | 实际作答/评分要求 | 对存储与判分的直接约束 |
|---|---|---|
| 中国教育考试网，2024 高考综合改革适应性测试数学，第 1 页单选、2 页第 9–11 题多选 [S1] | 单选每题 5 分；多选每题 6 分，「全部选对的得6分，部分选对的得部分分，有选错的得0分」 | 单选/多选的响应基数必须显式；选项集合与计分策略分开。**该题面没有给出部分分数值，不能编造按选项比例计分或固定 3 分** |
| 同卷第 12 题 [S1] | 给集合 A={−2,0,2,4}、B={x: abs(x−3)≤m}，求使 A∩B=A 的 m 最小值；答案写一个空 | 解题可以复杂，提交却只是数值。求解难度不等于核对答案难度；有经过核验的答案键时不必每次重解 |
| HKEAA 2024 TSA 中三中文阅读 9CR2，题 5/13/23 [S2] | 5：萬馬奔騰；13 接受多种表达如放棄/退縮/屈服；23 接受查詢方法/聯絡方法/查詢；都注明多于 4 字不予评分 | 参考答案可以是一组可接受表达；语义相近与字数约束同时存在。**短答 ≠ 全交 LLM；中文阅读 ≠ 全是开放论述** |
| IELTS Listening 官方题型说明 [S3] | 单选/多选、配对、图示标注、表格/笔记/流程图填空；每空可有不同词数限制，超词数失分；带连字符词算一个词 | 同一材料多个独立作答位置；配对是标识对、排序是有序列表，不应全部压成答案文本。字数规则要具体到计数口径 |
| AP Calculus AB 2025，FRQ 3A，PDF p2 [S4] | 用差商求 R′(1)；P1 要有数值与列式，P2 独立给正确单位，单位可不附在数值后 | 结果正确不能替代要求的过程；数值、单位不是通用的 0/0.5/1 梯度。该题单位分和过程分独立 |
| AP 同题 3B，PDF p3 [S4] | P3：可微所以连续；P4：区间两端跨过155、连续并作出存在性结论。不必拿 P3 才可拿 P4 | “证明”也有不同得分条件；不能机械地与参考解答逐句/逐步对齐 |
| AP 同题 3C/3D，PDF p4–5 [S4] | 梯形法有替代写法、部分正确的规则和特例；3D 中 P9 通常要求已获 P8；正确未化简表达式可锁定分数，后续化简错不再扣该分 | 评分有依赖、替代证据和例外；简单累计命中关键词不够，不能把通用 DAG 依赖当成全部评分语义 |
| Cambridge 0972/06，2018 specimen，p2–5 [S5] | e.c.f.：前问错值带入后，后续方法正确仍可得分；单位扣分通常每题至多一次；表格含容差/有效数字；作图有轴标、比例、描点精度、线宽；实验改进从候选中任取若干并封顶 | 需要跨空/跨小问上下文、题组级约束与原图证据；不可所有小问完全孤立，也不可每个空都当一次独立学习经历 |
| IELTS Academic Writing 官方说明 [S6] | 图表描述与观点论证；按任务完成、连贯衔接、词汇、语法四维评分；Task 2 权重为 Task 1 的两倍 | 不是比较一个“标准答案”；需等级描述/维度结果、样例和任务权重，范文只能是样例 |

### 1.2 标准/成熟系统的交叉检查

- **QTI 3** 明确区分内容、交互、响应声明、响应处理与结果；多选响应是 ID 集合，排序是有序 ID，配对是 ID 对；一道 composite item 可以有多个 interaction。[S7 §3.3–3.7]
- **STACK** 分开检查“代数等价”和“写成要求的形式”。`FacForm` 同时检查等价与因式分解形式；`LowestTerms` 本身不证明代数等价。[S8]
- 设计推论：`kind='fill_blank'`、`reference_md='…'`、`judge='semantic'` 无法表达这些差异。借鉴语义拆分，**不实现完整 QTI XML、通用考试平台或完整 CAS**。

## 2. 新模型：五层各自回答一个问题

### 2.1 题目结构：学生看到了什么

保留现有 `StructuredQuestion` 的题组/小题结构方向，**编辑态只有一棵结构化题树**（编辑/抽取工作态）；发布时冻结为不可变、可追溯的 **题目版本 QuestionRevision 快照**，发布后不再从 revision 反向自由编辑，也不维护第二棵可独立编辑的题树。目标是发布时形成：

- 原始来源：官方试卷/答案页、页码/定位、源文件 digest；生成题记录模型/任务版本和 grounding。
- 内容：共享材料、题面、图表、附件；材料/附件各有稳定 ID 和版本/digest。
- 结构：题组和可作答小题，`part_id` 持久化，不随位置重排重新编号。
- 显示题号/选项字母与身份分离。`option_id` 是身份；A/B/C 是这次展示的标签。
- 与已有 `question.id`、`parent_question_id`、part projection、KC 关系保留映射；题组是共享材料/联合规则边界，不新增一个 FSRS 调度单元。

**发布权威与身份轴（复核补正）**：

- 现有**物理子题行**（`createQuestionPart`，`src/server/questions/parts.ts:108–148`，`kind='question_part'` + `parent_question_id`/`part_index`）与 `structured` 树内的**结构化子节点**（`src/capabilities/practice/server/judge/narrow-part.ts:12–17`，`part_ref` = `StructuredQuestion.id`）是**两条不同的身份轴**，不能互相冒充，也不能按位置或文本相等推断为同一身份。
- 历史映射必须显式：`(question_id, legacy part_ref?) → (revision_id, part_id)`。**不允许按数组位置、题面文本相等或选项字母猜同一性**。
- 题组发布是**原子**的：题组与全部子题、part projection 同事务发布；服务（serve）时 pin 具体 revision，**重抽取不得静默复用旧身份**。

**原始扫描/抽取事实、整理后的题面、模型补出的答案不能互相冒充。** 题面改了但答案没同步、父材料改了但子题还引用旧版本，都必须被发布校验拒绝。

### 2.2 作答要求 ResponseSpec：学生交什么

每个可作答小题有 1..N 个 `response_slot`；一个空不是天然一张 question 行，也不是天然一次 attempt。

| 响应形态 | 数据，而不是 UI 名字 |
|---|---|
| choice | `selected_option_ids[]`，显式 single/multiple、允许选择数；空集合表示未作答，不等于字段缺失 |
| text | 原始字符串，文字/公式可混排；长度、语言、是否需引用原文等要求单独声明 |
| numeric / expression | 保留原始文本；结构化数值、单位、数学表达式是可追溯解释，不覆盖原文；定义域、精度/形式要求在评分规则中 |
| matching / ordering | ID 对或有序 ID 数组；数据模型可表达，未做交互实现前不宣称产品支持 |
| extended response | 文本 + 0..N 个学生证据附件；用于计算过程、证明、阅读、作文、手写图像 |

每个 slot 定义允许证据类型、是否允许留空、是否需要过程/图像。附件可绑定一组小问，例如学生上传一张完整解题纸，不强制切成 N 张。

**三种粒度必须分开（复核补正）**：**响应槽（response slot）** 是学生交什么；**联合评分组（evaluation group）** 是需要一起判的 slot 集合；**学习证据单元（learning evidence unit）** 仍是知识点/小题语义（ADR-0028），不是 slot、也不是 criterion。criterion 不创建复习，只有真实小题 attempt 才进学习投影。

- 有依赖的响应必须一起定稿：依赖题要么与前置响应一起完成并**一起结算**，要么在前置缺失时保持 **provisional 且不结算**。
- **ECF（前问错值带入）不得用参考答案替代缺失的前置学生作答**；缺前置学生答案时不能假装学生带入了某个值。
- 独立 sibling 保持独立可用；依赖子题不得在没有必要上下文（共享材料/前置答案）时被单独提供。
- 同一 KC 上的两道真实独立小题不得因为“看起来重复”被误去重。

提交的 `ResponseSet` 绑定 **实际展示的 revision**、小题/slot ID、当次选项展示映射、原始答案和原图；OCR 转写为派生 observation，记录转写版本和位置引用。题面图片与学生图片身份不同，不能串用。

“空白”“未提交”“图片无法识别”“格式不支持”“明确答错”必须分别表达。真正空白按已发布规则可计零分；基础设施失败/无法识别不得伪装成零分。

### 2.3 评分依据 MarkingSpec：凭什么给多少分

`reference_md` 可以继续用于讲解，但不再独自担当评分契约。按小题选择最小充分的三种表示：

1. **答案键 answer_key**：选项集合、可接受文本、数值/单位/容差或表达式条件；包含适用约束与计分策略。
2. **得分点 criteria**：稳定 criterion ID、描述、可选离散得分档、证据要求、局部依赖/替代规则、满分；保留完整原始评分说明。
3. **等级量表 levels**：作文等各维度的等级描述、分值映射、维度权重和总体换算约定。范文单独存，不当唯一正确答案。

共同字段：`max_points`、规则来源与定位、版本、来源性质（official / authored / model_proposed）、审核状态、reference/exemplars（可选）、题组级说明。

**来源权威 ≠ 抽取断言 ≠ 核验准入（复核补正）**：

- **来源权威（source authority）**：官方 PDF/评分表本身。
- **抽取断言/派生（extraction assertion / derivation）**：LLM 对权威内容的转写、整理与推导。**官方 PDF 不代表 LLM 转写已被核验。**
- **核验准入（verification admission）**：是否已被人工/确定性核验到可自动判分。
- 三个状态必须分开表达：**结构合法**（schema 通过）≠ **政策完整**（规则来源不缺失）≠ **准入自动判分**（admitted auto-grade）。
- 模型拟定的标准默认 `model_proposed`，**其自动判分准入须 owner 批准**，不能因 JSON 校验通过就当成官方规则。

**硬规则由代码执行**：集合匹配、显式部分分映射、长度计数、数值比较、单位换算、合法分值、求和/权重、上限、明确的扣分上限。规则来源不完整则标待补，不让模型补造后冒充官方规则。

**语义规则由模型判断**：是否表达了某观点、论证是否成立、替代解法是否满足要求、图像是否构成证据。复杂依赖/特例保留评分原文，由高级 LLM 联合评判并给出依据；第一版**不编译成任意可执行 DSL**。代码仍校验结果 ID、分值档、证据存在和确定的聚合不变量。

例：AP 3A 应是“列式与结果”1分 + “单位”1分，不是“量纲对但单位错给0.5分”。这不是废掉单位判分，而是把**单位检查**与**此题如何给分**分离。

### 2.4 执行计划 EvaluationPlan：用什么工具判断

执行计划由录入 LLM 在完整读取题面、答案、评分依据后提出，并随 revision 保存。**它是受校验的计划，不是模型可自由扩权的指令。** 学科配置提供默认偏好/可用能力，不能在提交时静默覆盖这份已发布计划。

- 最小规划单位是可评分小题；有跨小问依赖时明确联合评分组与所需材料，不机械地每个 criterion 调一次模型。
- 对用户仍可表现为“确定性 / 快速语义 / 高级判分”三类；技术上不是三类题型。
- 计划内容：比较/推理所需能力、必须的材料/证据、首选执行器、升级原因码、计划生成模型/版本、策略版本。
- 文本长度只是成本/上下文限制，不是选择 Jev 的本质标准。
- 模型/服务版本由执行策略绑定；每次运行记录实际模型。换 provider 不应重定义题目的评分意义。

**运行时有权升级、无权悄悄放宽规则**：本来是短答但学生上传手写证明、图像不可读、出现未覆盖的数学语法、模型输出冲突，都升级或挂起。不会因为“fast”标签而强行字符串比较判错。

### 2.5 判分记录 Evaluation：这一次依据哪个版本作了什么判断

复用现有 event / ai_task_run / durable pending 基础设施，**不平行新建一套判分任务系统**。

- 关联 submission/attempt 身份、question revision、marking/plan/policy 版本、输入 digest。
- 保留每次执行的执行器/模型、输出 digest、耗时/token/成本、升级链和错误状态。
- 结果含各 criterion/维度的 awarded/max、证据位置、解释、有效总分和状态；最终分值由允许的档位/聚合规则确定。
- 区分“答案得了几分”与“模型对此有多确定”。**Jev 概率/期望值不能直接成为学生得分。** 例如对0分/2分不确定，不意味着应给1分。
- `pending / graded / needs_review / failed` 等处理状态与 `unanswered / incorrect / partial / correct` 作答结论分离。未决项可有诊断信息，不能向学习投影冒充已判错。
- 重判追加新结果，显式指向被替代结果，旧版本保留；同一 submission 的唯一生效结果用原子更新/并发控制选定，重试不能成为一次新练习。

**候选判分 vs 已接受判定（复核补正）**：

- **候选/影子（candidate/shadow）输出不得进入普通有效判分通道**，也不参与 newest-judge wins；它们只能进影子比较/评测面。
- **接受（accept）与替代（supersede）必须显式**；重试的 evaluation 身份与 submission 身份分离——重试不是一次新练习。
- 同一幂等键对应不同 body/附件/revision = **冲突**，不得静默覆盖；提交并发下用 CAS，以“期望的当前结果”为前置条件。
- **现有 rejudge 保持不动**：不通过 `handleRejudge` 引入新的 revision-backed 比较。
- LIGHT 只对**新路径**禁用有效历史替代，不隐含移除 legacy 申诉。

## 3. 确定性、Jev、高级 LLM 的新职责

### 3.1 三类执行，而不是三类存储

| 场景 | 推荐执行 | 升级/不确定行为 |
|---|---|---|
| 单选、多选、稳定 ID 配对/排序 | 确定性；按此题公布的政策给分 | 答案键/部分分政策缺失则待补，不交模型猜 |
| 可接受文本精确命中、字数/格式硬约束 | 确定性快速检查；归一化范围按题配置 | 未命中 ≠ 一定错误；是否允许语义等价由评分依据决定 |
| 数值填空、明确单位/容差 | 已验证的数值/单位比较器 | 未支持的格式/范围走高级 LLM 或待复核；不假设 Jev 会数学 |
| 边界清楚、文本已可读、单步语义短答 | Jev 候选，经过本地该语言/题型评测后启用 | 不可用、低置信、矛盾、范围外 → 高级 LLM |
| 公式等价且要求特定形式/定义域 | 有已验证比较器则使用；否则高级 LLM | 代数能力不能靠简单字符串归一化伪造；本轮不引入完整 CAS |
| 阅读推断、解释、证明、过程分、作文、依赖图像 | 高级 LLM，必要时具备视觉能力 | 材料缺失/原图模糊/规则缺失 → needs_review，不编答案 |

这修改了之前“数学填空→Jev”的 blanket 分配，但保留“便宜的先做；不可靠时升级”的产品意图。**建议 owner 批准此修正，不擅自视为批准。**

**Jev 适用性定义（复核补正）**：Jev 的资格是「在**已评测的语言/领域内**做**窄语义判断**」，不是「题目短」或「原题简单」；长度只是成本/上下文约束。本轮**未做 Jev 或高级 LLM 的 actual-output 评测**，不声称任何校准或概率到分数的映射，也不声称 Jev 已可用。

### 3.2 Jev 已核实与未核实的边界

官方 jaggedness 原文：“Jev is not a calculator. We strongly recommend implementing any mathematical logic in code.” 并明确不擅长数值精度、计数、多跳间接推理，存在 adversarial state 风险。[S9]

官方文档明确：当前 text-only；CJK 可输入但准确率低于主要训练语言英语；Choice 可返回多类别，Score 返回对离散等级的概率加权值，**不是天生只能二分类，也不是不能辅助部分分**。[S10]

`confidence` 是分布派生统计量，不等于该次答案正确的概率；官方“校准”也不能替代本应用评分数据评测。[S10] 不在提案里拍一个全局 0.8/0.9 阈值。按固定模型、语言、题型、评分政策验证后，以策略版本管理升级阈值。

成本按官方当前 input-token 价格计算，不再宣称固定 `$0.0004/题`；端到端还要算输入预处理、升级比例和高级模型。没有实际调用，不给本应用准确率、延迟和节省比例承诺。

Jev 不生成自由文本解释/证据引用。快速路径可以记录所评 criterion、原始输入定位及概率，用已有规范化反馈；**不得伪造“模型摘录的依据”**。若产品要求逐句证据与个性化讲解，可独立触发高级解释，或直接高级判分。

高级 LLM 同样可能出错：按规则与证据给分、校验结构，无法确定则挂起；“fallback”不意味着最终必然可靠。

## 4. 录入流程：先完成评分契约，再让题进入练习池

```text
来源原件 / AI 生成输出
  → 抽取题目结构（不把学生手写答案当标准答案）
  → 对齐每个小题与作答位置、原答案/评分来源
  → LLM 整理 MarkingSpec + 提议 EvaluationPlan
  → 确定性结构校验 + 必要的答案核验
  → 发布不可变 revision（或保留 draft/needs_review）
  → solo / paper 使用同一发布版本、同一提交与判分契约
```

发布校验至少包括：ID唯一且引用存在；选项键有效且数量可行；slot/criterion覆盖明确；小题分与题组分一致；容差/单位/定义域契约有效；跨题依赖指向存在；执行器可用并具备所需模态；官方/生成评分来源区分；未决评分政策不得标 auto-gradable。

计划不是上传就无限付费：沿用现有 baseline / discretionary 升级授权与预算边界。录入 LLM 提议需要额外高成本验证时，应按现有授权机制处理，不自行加后台大规模补全。

没有官方标准答案时可以由模型提出参考与评分规则，并标记 model_proposed；不能因 JSON 校验通过就宣称答案正确。开放作文可没有唯一 reference，但必须有可用的评分标准。

## 5. 数据落地与迁移：改契约，不推倒事件系统

### 5.1 建议物理归属（待 schema 设计确认，不是本轮 migration）

| 现有承载 | 目标职责 |
|---|---|
| `question` 及现有 parent/part 关系 | 稳定身份、检索/KC关联、当前发布版本引用；旧列在迁移阶段作兼容投影 |
| 新的不可变 `question_revision`（一类版本记录） | 发布时结构化题目快照 + ResponseSpec + MarkingSpec + EvaluationPlan；JSONB 由严格 versioned schema 约束 |
| 当前 `structured` 草稿/抽取存储 | 编辑/抽取工作态；发布后从 revision 生成派生列，不与 revision 双向自由编辑 |
| 现有提交/判分 events 与 durable pending | versioned ResponseSet、执行和结果快照、supersedes 关联；不建第二套 attempt/grade 真相 |
| 现有 blob/asset | 原图和答题证据；保存定位、digest、访问权限，判分记录只引用 |

revision 是**一个题组的一致发布快照**，子题引用同一 revision 的 part ID；单题也是一个题组大小为1的特例。现有拆题 question 行映射到这个聚合，不重编号历史 ID。父材料/评分规则改变时新发布整组版本，避免子题引用飘移。

对外练习 DTO 只输出题面与作答要求，**不返回答案键、评分私有内容、未公开参考解答或可泄题的执行计划**；不能直接把 revision JSON 整体发给浏览器。

### 5.2 分阶段切换

1. **定义契约 + 样例集**：先用下述真题/评分样本证明表达力；确定历史映射和无损读取。非实现审批前不改 DB。
2. **新题纵切**：选定一个实际录入 producer（原 LIGHT-1 建议为 `question_author`；owner 已裁决不分批、全量迁移，见 §8 顶部注），发布→作答→判分→落事件全链落地，再扩到 OCR/确认导入、sourcing、quiz_gen 等其它 producer；不做只有 helper 没有 consumer 的新子系统。
3. **新旧双读、单一路径写**：新题写新版唯一真相；旧题走显式 legacy adapter。新题不允许中途落回旧列猜路由；旧机制不删除。
4. **历史只读分类/影子比较**：明确单选且答案可无歧义映射的题可建议机械迁移；无版本/答案含糊/复合题需要复核。保留原数据和映射，不做全库强制回填、不后台偷偷调用模型。
5. **逐来源切换/可回滚**：统计该来源覆盖、pending、失败、升级率；保留 legacy 读取直至覆盖验收。不是把所有 `semantic` 重命名“高级判分”。

### 5.3 学习状态保护与重判

同一完整提交可以得到多个 slot/criterion 分数，**不等于发生多次复习**；继续遵守知识点是调度单元的已定边界。学习证据按现有小题/KC语义去重，不能按 criterion 发 FSRS review。

**评级 provenance 与结算消费者（复核补正）**：

- 评级来源必须区分 **user-confirmed**（用户确认）与 **judge-driven**（判分驱动）；冻结当时的映射策略、KC 集合与原始有效时间。
- 完整结算消费者清单（`review-settlement.ts` 实证）：**FSRS、θ̂、family/难度校准、progress、wrong-streak、prerequisite risk**。
- 若日后 replay 纠正，必须按**原始事件时间**而非申诉时间重放相关投影；**当前不建设 replay 平台**。

得分到 FSRS rating / θ̂ / mastery 的映射是独立且版本化的策略。作文6/9分不是自动代表每个相关KC都“掌握了2/3”；不能把部分分直接按比例复制给所有知识点。

复判追加判分事件，不重复记一次学习。历史 FSRS 是顺序相关状态，不能通过“再应用一次新rating”修正；若要让纠正影响学习状态，须可审计地替换有效学习证据并从合适 checkpoint/历史重放相关投影。**此处是新要求，不是宣称现代码已支持**。

LIGHT 可以先提供只读复核对比；在有效结果替换与投影纠正尚未验收前，不允许对已影响学习状态的判分发布“生效重判”。不会让界面新分与旧 mastery 无提示地矛盾。

## 6. 与当前代码的具体距离

本轮只读核查确认：

- `src/db/schema.ts:406–415,434–459`：question 已有 reference/rubric/choices、parent/part、metadata/figures/structured；choices 是 `string[]`，不是稳定 option ID。
- `src/core/schema/structured_question.ts:267–277`：已有递归结构、node ID、答案和解析。存在树内身份不证明跨重抽取身份稳定。
- `src/capabilities/practice/ui/PfSolo.tsx:314–316,370–386`：solo 用一个 `sel` 索引取选项文本，提交一个 `response_md`；**exact helper 会比较多字母集合不等于产品已支持多选**。
- `src/capabilities/practice/api/contracts.ts:9–35` 和 `server/paper-submit.ts:83–95`：响应边界主要是文本加 image refs；图片数组不等于选择数组。paper 实际选项控件未完整核查，不对其交互能力下结论。
- `server/judge/route-resolve.ts:182–274`：override / choices / profile / reference metadata 参与派生。新版要明确发布计划与兼容路由优先级，不能只加新字段仍让旧 override 改写意义。
- `server/judge-run-payload.ts:125–145` 与 `src/core/schema/event/judge-pending-events.ts:47–59`：已有 frozen question/profile/body snapshot，应扩展复用，不重建任务系统。
- `CONTEXT.md:28–35`：知识点调度、rejudge 追加事件、模型版本/provenance、判分不读个性记忆，均为现有设计边界。

### 6.1 独立架构复核实证（source-grounded，非测试结论）

- **两条身份轴**：`src/server/questions/parts.ts:108–148` 写的是物理子题行（`kind='question_part'` + `parent_question_id`/`part_index`）；`src/capabilities/practice/server/judge/narrow-part.ts:12–17` 明示 `part_ref`/`sub_ref` **严格只在 structured-jsonb 轴**（= `StructuredQuestion.id`），不存在 question_part 行、per-小题 FSRS、per-sub θ̂ fan-out。`narrow-part.ts:57–104` 的 narrow 保留父 stem passage 但**剥掉 sibling sub**，reference 只从 narrowed 子树派生（防 C1 泄漏）。→ §2.1 的两轴不可互推。
- **重判现状**：`src/capabilities/practice/jobs/rejudge.ts:128–149` 重判取**当前 question 行**与**当前 profile**，输入只有文本 `answer_md`，**不带 image refs / part_ref**；`:154–179` 只用 coarse outcome 比较（`newOutcome === priorOutcome`）；`:227–292` 写新 judge event + correction supersede + θ̂ revert（同事务）；`:303–327` 写 deferred reproject marker，**不是已完成的 replay**；`:14–21` FSRS 段刻意不改写（评级是用户确认动作）。→ §2.5/§5.3 的“现有 rejudge 保持不动”有据。
- **判分展示**：`src/capabilities/practice/server/practice-read.ts:269–308` 列表按 slot 取 **newest judge** 的 coarse_outcome（newest-wins 展示语义已存在）。
- **结算消费者**：`review-settlement.ts:174–268` 写 FSRS + θ̂ + family/难度校准；`:823–855` 再发 mastery progress / wrong-streak / prerequisite risk；deferred 路径 `:312–414,483–524` 在 late arrival 时降级为 **evidence-only，不写派生投影**。→ §5.3 消费者清单与“provisional 不结算”有据。

以上为**独立来源复核**结论，**不是测试结论**；producer-wide（各 producer 最终入库映射、paper 多选 UI、rejudge worker 的实际 mutation/FSRS/mastery 消费与 replay）**审计仍开放**。

**实施前仍须追通**：各 principal producer 最终入库映射、paper 多选 UI、重判 worker 的实际 mutation/FSRS/mastery 消费与 replay。两轮 explorer 只得到部分 source，不能冒充完成全链审计。来源字段完整性/消费者路由以实代码为准，不沿用之前 reference_solution=完整评分细则的错误推断。

## 7. 验收方法：既验证模型，也验证规则与副作用

### 7.1 数据/确定性验收

固定 revision 的真实结构样本至少覆盖：单选；多选全对/漏选/错选/空白；中文短答多答案+超字；多空/表格；数值单位与容差边界；表达式形式约束；AP独立/依赖/例外得分；Cambridge 图像与带错续算；作文等级。

自造学生反例必须标 synthetic，不冒充官方考生答卷。可使用 AP 已公开学生样本及官方逐点判分作参照，保留授权/引用边界，不把完整受版权试卷直接复制进仓库。

性质测试：选项展示重排**仅在该题语义允许重排时**不改分（含 all-of-above、标签引用等默认禁止重排）；无序多选顺序不改分；有序回答交换改变含义；revision 编辑不影响旧提交；同幂等键改答案/附件冲突；重复重试不重复应用学习副作用；OCR/超时失败不计错误；分数不超边界；部分未决不自动当零分。

### 7.2 模型 actual-output gate（需单独授权/凭证/预算）

- 人工标注且有争议裁决的样本，按语言/题型/模态/规则分层；官方考生样本优先，但避免只测可能已被模型记忆的公开题。
- 训练/阈值调参与留出评测按题族和材料划分，避免同一道题改写答案泄漏到两边。
- 分别测 false accept、false reject、逐点/总分误差、等级一致性、升级覆盖/剩余风险；不是只报 overall accuracy。
- 固定 Jev 与高级 LLM/model/prompt/parser/policy revision；输入输出 digest、task-run、成本、延迟、重试与升级成本留档。
- 手写歧义、缺图、长阅读、否定、替代解法、跨问带错、学生答案中的 prompt injection 必须进困难切片。
- 门槛与样本量在 eval plan 明确并由 owner 确认；不凭几道 happy path 声称上线安全。

## 8. LIGHT / FULL 与建议

> **2026-09-24 owner 裁决（取代本节）**：owner 认可五层模型方向，明确**不分批**、要全量迁移、支持任意题目、一次产品切换，**拒绝 LIGHT/LIGHT-1 分批上线**。以下 LIGHT/LIGHT-1 内容保留为决策历史，不再是执行方向；新工作计划见 [implementation grounding](2026-09-24-question-assessment-implementation-grounding.md)。owner 接受的是**方向**，不是已实施。

**LIGHT（历史建议，已被 owner 拒绝）**：保持上述领域模型，实施范围限当前消费者：稳定单/多选ID、多空/文本+图片证据、答案键/得分点/等级三种评分契约、发布版本与统一结果；确定性保留，高级LLM有契约与失败态；Jev先离线/影子验证，再按已验证切片启用。不做通用规则语言、完整CAS、QTI进出口、配对拖拽/在线作图编辑器，不自动大迁移历史。

### 8.1 第一纵切 LIGHT-1（历史建议，已被 owner 拒绝）

LIGHT-1 曾是本轮建议的首个可实施切片；owner 已裁决不分批，以下保留为决策历史：

- **Producer**：保留现有 `question_author`（`src/capabilities/practice/server/tools/question-author.ts`）。
- **Consumer**：`solo`（`PfSolo`）。
- **首个响应/评分范围**：单/多选**答案键**，以及该 producer 必需的**现有文本作答高级判分路径**。
- **不声称**所有复杂契约（多空/配对/等级/依赖评分组）已就绪。
- **服务与提交输入不可变**；同一 submission 只接受**一个 accepted 结果**，**once-only 结算**。
- **不在首切片**：Jev 激活、联合依赖评分组/新交互、有效历史替代、大迁移。
- §1 的 AP/Cambridge/IELTS 案例是**设计表达力示例/未来 gate**，**不是首切片实现承诺**。
- 多 slot / criteria / levels、配对/排序等交互属 **LIGHT 后续**；CAS/QTI 等属 **FULL**。
- **Shuffle invariance 仅在语义允许重排时成立**；all-of-above/标签引用默认禁止重排。

**FULL**：在同一模型上加 CAS、更多原生交互与视觉几何测量、复杂规则编译、全量历史迁移与投影纠正工具。能力更多，也明显扩大依赖、验证和维护成本；目前没有必要一次建设。

待 owner 确认的实质决策（**2026-09-24 更新**）：

1. 接受“确定性检查优先；Jev做已验证的窄语义判断”替代“所有数学填空→Jev”吗？
2. ~~采用 LIGHT 起步，还是要求 FULL 的具体能力？~~ **已裁决：全量迁移，一次产品切换（不分批）。**
3. 非官方来源缺评分标准时，允许模型拟定并显式标识练习用标准，还是一律等人工确认才入可自动判分池？

后续实质决策以 implementation grounding 的 owner 决策清单为准。

历史迁移、复判回算、阈值数值和生产上线仍须后续具体计划，不借本提案一揽子授权。

## 独立复核处置（2026-09-24）

独立架构复核（Oracle lane）对草案给出修正，已全部归并，**未标记为已批准实施**：

| 复核项 | 处置 |
|---|---|
| §2.1/§5.1 发布权威：一棵可编辑树 + 不可变发布快照 | 已归并（身份两轴、显式映射、原子发布/serve pin） |
| response slot / evaluation group / learning evidence unit 区分 | 已归并（§2.2） |
| candidate vs accepted judgment | 已归并（§2.5） |
| rating provenance 与结算消费者 | 已归并（§5.3） |
| MarkingSpec 来源权威/抽取断言/核验准入 | 已归并（§2.3） |
| Jev eligibility 窄语义判断 | 已归并（§3.1/§3.2） |
| LIGHT-1 首切片 | 已归并（§8.1）；**owner 已裁决拒绝分批，见 §8 顶部注** |
| §6 source-grounded 实证 | 已归并（§6.1） |

复核证据为**独立来源审阅**，不是测试结论；producer-wide 审计仍开放。owner 决策与 Linear capture 见 PLAN/handoff。

## 一手来源

- **S1** 中国教育考试网：[2024年高考综合改革适应性测试：数学试题及问卷调查](https://www.neea.edu.cn/xhtml1/report/2401/426-1.htm)。亲读原卷[第1页](https://www.neea.edu.cn/res/Home/2401/24010420.jpg)、[第2页](https://www.neea.edu.cn/res/Home/2401/24010422.jpg)。本轮未取得该卷官方详细评分表，不推断部分分数额。
- **S2** HKEAA：[TSA2024_9CR2_MS.pdf](https://bca.hkeaa.edu.hk/web/Common/res/2024secMarking/S3/TSA2024_9CR2_MS.pdf)，p1，官方评卷参考；不是整份HKDSE开放阅读评分细则。
- **S3** IELTS：[Academic Listening format](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-listening)，Types of question / gap completion / short-answer。
- **S4** College Board：[AP 2025 Calculus AB Q3：评分细则、学生答卷、评分评论](https://apcentral.collegeboard.org/media/pdf/ap25-apc-calculus-ab-q3.pdf)，p2–5规则、p6–11手写样本、p12–13官方评分评论。亲读样本3B：总分6，A因单位错误仅1/2；B缺连续性表述0/2；C、D得满分。
- **S5** Cambridge：[Physics 0972/06 2018 specimen mark scheme](https://www.cambridgeinternational.org/Images/327879-2018-specimen-paper-mark-scheme-6.pdf)，p2通则、p3表格/作图、p4–5实验/设计。不是2024年9702试卷，勿混淆。
- **S6** IELTS：[Academic Writing format](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-writing)，Marking / Tasks 1 and 2。
- **S7** 1EdTech：[QTI 3 Beginner’s Guide](https://www.imsglobal.org/spec/qti/v3p0/guide)，§3.3–3.7；用于模型交叉检查，不声称本系统符合QTI。
- **S8** STACK：[Algebraic Form answer tests](https://docs.stack-assessment.org/en/Authoring/Answer_Tests/Form/)，FacForm / SingleFrac / LowestTerms。
- **S9** TypeSafe：[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)，Math and Numbers / Indirection / Adversarial content；主会话亲读正文。
- **S10** TypeSafe：[models](https://docs.typesafe.ai/models)、[confidence](https://docs.typesafe.ai/confidence)、[primitives](https://docs.typesafe.ai/primitives)、[API](https://docs.typesafe.ai/api)、[System One](https://docs.typesafe.ai/concepts/system-one)、[State](https://docs.typesafe.ai/concepts/state)。librarian核查；主会话从官方llms-full正文复核API/State/System One。价格和版本是访问时快照，不保证未来不变。

所有URL本轮访问日期2026-09-24。没有把搜索摘要、第三方镜像、营销“零幻觉”或供应商置信数值当作本应用准确率证据。
