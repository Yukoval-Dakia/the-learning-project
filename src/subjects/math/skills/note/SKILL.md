---
name: note
description: 数学学习笔记规范包 —— 合格 atomic / long / hub note 的结构要求、各 semantic_kind 内容标准、质检判据。NoteGenerateTask / NoteVerifyTask / NoteRefineTask 共用同一份规范。
---

# 数学学习笔记规范

数学笔记围绕定义、公式推导、解题策略和易错模式，帮助学习者把「做对这道题」的能力转化为「遇到同类题型都能正确建模、计算」的持久规则。

## atomic note 的 semantic_kind 结构（必须覆盖全部五种）

| semantic_kind | 内容要求 |
|---|---|
| definition | 写清定义、适用条件和符号含义。 |
| mechanism | 拆解公式来源、变形依据和解题策略。 |
| example | 给出带步骤的短例题，保留关键中间式。 |
| pitfall | 列出易漏条件、计算错误和方法误选。 |
| check | 给出一个同类小题或一步推导检查。 |

每个 semanticBlock 必须设 `source_tier="llm_only"`、`user_verified=false`、`version=1`、`source_markdown`。

## 内容质量要求

- **definition**：给出概念的严格数学定义，明确适用范围和约束条件（如「正弦定理仅适用于任意三角形，不要求直角」），符号含义需明示（如 $a, b, c$ 表示对边长，$A, B, C$ 表示对角）。
- **mechanism**：拆解公式推导链路或解题策略步骤，说明「为什么这一步合法」。关键变形依据（定义/等价条件/已知定理）必须标注，不能跳步。
- **example**：用一道短例题（1–3 步完成）展示核心方法，保留关键中间式。不要只给最终答案；步骤是给学习者建立「这样想就对了」的模板。
- **pitfall**：直接列举高频错误类型——易漏条件（如忘记 $x \neq 0$）、计算陷阱（如符号错误）、方法误选（如用正弦定理却忘判歧义情形）。每条 pitfall 说明「什么时候会犯」和「正确做法」。
- **check**：一道同类小题（可以是「完成这一步推导」或「判断下列条件下公式是否适用」），考查 definition 或 mechanism 的核心判断，不考超出本 atomic 范围的内容。

## note_long / note_hub 要求

- **note_long**：综合多个知识节点（如「等差数列三种表达及互推」「二次函数与判别式综合」），自由 block tree，重点在建立知识点之间的推导关系和解题路径，不强制逐段 semantic_kind。
- **note_hub**：是专题路线图，用 crossLinkBlock 串联相关 atomic/long，给出从基础定义到综合应用的学习顺序提示；不要假装是单知识点 atomic。

## 质检标准（NoteVerifyTask 共用）

- **factuality**：公式是否正确，推导是否自洽；条件不足时指出缺少的条件，不编造定理。
- **coverage**：atomic 必须覆盖全部五种 semantic_kind；long 检查综合范围是否完整。
- **subject_fit**：例题是否是典型数学题型；使用的符号和术语是否符合高中数学规范；pitfall 是否针对该知识点的真实高频错误。
- **clarity**：学习者能否按 mechanism block 复现解题步骤。

## 质检判定规则

- 没有 error 且 warn ≤ 2 条：verdict="pass"
- 任一 error，或 warn > 2 条，或 confidence < 0.6：verdict="needs_review"

## 禁止

- 跳过关键推导步骤只给结论
- definition 缺少适用条件
- atomic note 缺少任一 semantic_kind block
- check 题超出本 atomic 范围
- 输出 emoji、营销话语、套话
