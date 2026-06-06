---
name: note
description: 物理学习笔记规范包 —— 合格 atomic / long / hub note 的结构要求、各 semantic_kind 内容标准、质检判据。NoteGenerateTask / NoteVerifyTask / NoteRefineTask 共用同一份规范。
---

# 物理学习笔记规范

物理笔记围绕物理定律、量纲分析、单位换算和推导链路，帮助学习者把「做对这道计算题」的能力转化为「遇到同类情境能正确建立物理模型、检查量纲」的持久规则。

## atomic note 的 semantic_kind 结构（必须覆盖全部五种）

| semantic_kind | 内容要求 |
|---|---|
| definition | 写清物理量定义、单位、矢量/标量属性、适用条件。 |
| mechanism | 拆解所用物理定律、推导链路、量纲一致性检查。 |
| example | 给出带单位的完整推导例题，保留中间量纲。 |
| pitfall | 列出易错单位换算、矢量方向、适用条件遗漏、量纲错位。 |
| check | 给出一个量纲检查或单位换算小题。 |

每个 semanticBlock 必须设 `source_tier="llm_only"`、`user_verified=false`、`version=1`、`source_markdown`。

## 内容质量要求

- **definition**：给出物理量的本质定义（如「加速度是速度对时间的变化率，不是速度本身」），标明 SI 单位（如 $\mathrm{m/s^2}$），声明矢量/标量属性，说明适用条件（如「牛顿第二定律适用于惯性参考系」）。
- **mechanism**：拆解物理定律的推导链路——「从哪条定律出发 → 做了哪些近似或约束 → 得到公式」。量纲一致性检查是核心内容：每个公式都应展示左右两端量纲相等（如 $[F] = \mathrm{kg \cdot m/s^2} = \mathrm{N}$）。
- **example**：用一道带数字的例题（给出初始条件 + 完整推导步骤 + 含单位的最终答案）展示方法。**每一步都保留单位**，中间量纲不省略；这是物理笔记区别于数学笔记的核心要求。
- **pitfall**：直接列举：（1）易错单位换算（如 $\mathrm{km/h}$ 与 $\mathrm{m/s}$ 互换忘乘系数）；（2）矢量方向错误（如合力与分力方向混淆）；（3）适用条件遗漏（如动量守恒忽略了系统是否受外力）；（4）量纲错位（如把 $v^2 = 2as$ 中的 $a$ 单位写错）。每条给出正确做法。
- **check**：一道量纲检查题或单位换算题（如「验证下列公式量纲是否正确」或「将 $72 \, \mathrm{km/h}$ 换算为 $\mathrm{m/s}$」），考查 definition 或 mechanism 的核心内容。

## note_long / note_hub 要求

- **note_long**：综合多个知识节点（如「匀变速直线运动五个公式及适用条件」「万有引力与圆周运动综合」），自由 block tree，重点在建立物理定律之间的推导关系和建模路径，量纲链路须贯穿全文。
- **note_hub**：是专题路线图，用 crossLinkBlock 串联相关 atomic/long，给出从基础物理量定义到综合建模的学习顺序提示；不要假装是单知识点 atomic。

## 质检标准（NoteVerifyTask 共用）

- **factuality**：物理定律是否正确，量纲是否一致；推导必须能追溯到物理定律、定义、量纲分析或题面条件；不能编造定律。
- **coverage**：atomic 必须覆盖全部五种 semantic_kind；long 检查量纲链路是否贯穿。
- **subject_fit**：example 是否携带完整单位；pitfall 是否针对该物理知识点的真实高频错误（特别是量纲和矢量方向）；check 是否考量纲/单位而非纯数学计算。
- **clarity**：学习者能否按 mechanism block 建立正确的物理模型并完成量纲检查。

## 质检判定规则

- 没有 error 且 warn ≤ 2 条：verdict="pass"
- 任一 error，或 warn > 2 条，或 confidence < 0.6：verdict="needs_review"

## 禁止

- example 步骤中省略单位
- definition 缺少适用条件或矢量/标量属性
- atomic note 缺少任一 semantic_kind block
- check 题考纯数学计算而不考物理量纲/单位
- 输出 emoji、营销话语、套话
