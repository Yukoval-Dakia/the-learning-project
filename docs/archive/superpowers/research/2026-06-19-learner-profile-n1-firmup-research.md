# 学习者档案 n=1 firm-up 方案调研（A1-A15 + 否决清单）

> **本文是调研结论 index。** 各幸存方案的工程落地以**对应 Linear issue（YUK-433~447）+ 各 phase plan doc** 为权威；本文给 n=1 litmus、分级幸存清单、诚实否决清单、天花板。4-lane 并行调研 → 对抗 n=1 过滤 → 统合；每来源按 venue / 评审 / n=1 适用性分级。
> 镜像：Linear Document「学习者档案 n=1 firm-up 方案调研（A1-A15 + 否决清单）」（slug 6f629a2b5299）。**repo 为源。**
> 历史注：本文 2026-06-19 由 P1 go-live 后的 D0 doc-gap 修复落入 repo（此前仅 Linear 镜像存在）。

## n=1 litmus（贯穿）

信号能加 ⟺ 以已知常数 / 充分统计量 / owner 供给固定先验 / 单学习者自身状态进入；**绝不**是需跨被试方差的 a / slip / guess / φ。

## 幸存方案（→ 见各 A-issue YUK-433~447）

* **Tier1**（peer-reviewed，直接 n=1，低成本）：A1 SRT（Psychometrika，最高杠杆）/ A2 分层Elo / A3 KLP / A4 网格θ
* **Tier2**（各需一次性供给先验/键）：A5 图-Laplacian / A6 prereq 有向 / A7 MEPV / A8 distractor→misconception / A9 step-grading / A10 confidence
* **Tier3**（preprint / by-analogy，先 prototype）：A11 EZ-diffusion 谨慎轴 / A12 LLM 先验→贝叶斯 / A13 prediction-grounding / A14 DAD / A15 LLM elicitation

## 诚实否决（别去追，省得重做这轮研究）

| 方法 | 判决 |
| -- | -- |
| PSI-KT / CF 低秩嵌入 | COHORT（跨 1000 学习者） |
| LLaSA→IRT 点估计 | COHORT / WALL（只配候选生成，绝不出点估计） |
| 直接 LLM 问难度 | WALL（中文低于随机） |
| vanilla 分层 RT 模型 | COHORT（用 A1 SRT 取代） |
| Deep-KT 选题底座 | WALL（单学生不可靠，保 PFA） |
| HIRT 作 scale anchor | PRIOR-ECHO |
| keystroke 定量 | COHORT（只配 mem0 定性） |
| GPCM / GRM 分步 | WALL（n=1 陷阱，用 A9） |
| neural-IRT 训练 | COHORT（仅推理期 blend 可移植） |

**共同死因**：承重估计活在 person×item 跨被试方差里。litmus：该方法需估新跨被试方差分量？是 → 穿 process-data 外衣的 cohort 方法。

## 诚实天花板

所有 firm-up 不破识别墙：θ（给定锚 b）/ p(L)（给定 locked slip-guess）/ 定性状态可 firm up；**难度尺度 anchor + per-item a/c/slip 在 n=1 仍不可估**。自适应选题 / 结构借用 / 丰富信号都是已锚定模型上的乘数，不替代 anchor。
