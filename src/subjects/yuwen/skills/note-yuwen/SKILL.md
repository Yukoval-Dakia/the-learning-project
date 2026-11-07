---
name: note-yuwen
description: 文言文学习笔记规范包 —— atomic / long / hub note 的组织原则、各 semantic_kind 内容标准、质检判据。NoteGenerateTask / NoteRefineTask 共用同一份规范。
---

# 文言文学习笔记规范

文言文笔记围绕词义、句式、阅读理解和翻译能力，帮助学习者把「做对这道题」的能力迁移成「遇到同类情境都能判断」的持久规则。

## atomic note 的结构（正文跟材料组织走）

atomic 正文跟随材料自身的展开组织：词义材料沿本义与引申写，句式材料沿判断步骤写，阅读材料沿文本证据与结论写。先按材料把正文写好，再用下表做一遍查漏——少了哪一维，读者理解这份材料会卡住？会卡的才补（可挂对应 semantic_kind 段，也可并进相邻正文）；五个维度都用不到就一维不加，材料已讲透的维度不重复写。读者可能卡住的地方（材料依赖却没有展开的先行知识、背景常识、隐含判断依据）可就地补一小段背景，以帮读者理解本材料为限。

| 维度 | 用到时写到什么程度 |
|---|---|
| definition | 术语或知识点定义，必要时给出古今义差异。 |
| mechanism | 解释语法功能、句式机制或阅读判断步骤。 |
| example | 引用短句并标明关键字词。 |
| pitfall | 列出常见误译、词性误判或题面误读。 |
| check | 给出一个小题检验是否真正掌握。 |

## 用到某维度时的内容标准

- **definition**：直接给出词义或句式的本质界定。古今义差异（如「走」=跑、「妻子」=妻子儿女）是核心内容，不能省略。
- **mechanism**：聚焦判断步骤——「如何判断这是介词还是连词」「如何分辨宾语前置」——给出可复用的操作规则，不是泛讲概念。
- **example**：优先引用课内原文短句，标明来源篇目。不要脱离材料泛讲。例句中关键字词须加粗或注释。
- **pitfall**：列举学习者高频犯的错，直接说「这个情境容易误译为 X，正确译法是 Y」。
- **check**：一道短题（不超过 2 句），考查 definition 或 mechanism 的核心判断，可以是单词辨义或短句翻译判断。

## note_long / note_hub 要求

- **note_long**：综合多个知识节点（如「宾语前置四种类型」「虚词『以』的七种用法」），用自由 block tree（heading/paragraph/bulletList/calloutBlock/crossLinkBlock），不强制逐段 semantic_kind，但内容必须有结构性不能泛讲。
- **note_hub**：是主题路线图，用 crossLinkBlock 串联相关 atomic/long，给出学习顺序提示；不要假装是单知识点 atomic。

## 质检标准（生成与精修共用）

- **factuality**：内容是否自洽，是否明显编造；材料不足时标注不确定，不编造出处。
- **coverage**：atomic 正文是否覆盖材料本身的要点（不以凑齐固定维度计）；long 检查综合范围完整；hub 检查路线和 cross-link。
- **subject_fit**：例句是否是真实文言原文（不能是自造伪古文）；术语是否符合中学文言文教学规范。
- **clarity**：学习者能否按 block 内容判断下一次遇到同类情境时该怎么做。

## 质检判定规则

- 没有 error 且 warn ≤ 2 条：verdict="pass"
- 任一 error，或 warn > 2 条，或 confidence < 0.6：verdict="needs_review"

## 禁止

- 编造伪文言原文作为 example
- 把例句来源模糊化（「有一句古文说…」）
- 为凑齐五个维度写与材料无关的空泛段落
- check 题考超出本 atomic 范围的内容
- 输出 emoji、营销话语、套话「希望对你有帮助」
