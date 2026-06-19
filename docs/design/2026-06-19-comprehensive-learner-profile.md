# 综合学习者档案统一设计（§0-§8 导航 index）

> **本文是导航 / index 文档。** 各轴（A1-A15）的工程细节以**对应 Linear issue（YUK-433~447）+ ADR（0035/0036）+ 各 phase plan doc** 为权威源；本文给愿景 + 装什么 + 分阶路线 + 诚实天花板的总览。
> 镜像：Linear Document「综合学习者档案统一设计（§0-§8）」（slug e206b5bba8e8）。**repo 为源。**
> 历史注：本文 2026-06-19 由 P1 go-live 后的 D0 doc-gap 修复落入 repo（此前仅 Linear 镜像存在，§2-§6 各轴细节从未持久化于单一 monolith，按本项目分布式-SOT 模式分散在 A-issues + ADRs + plan docs）。

## §0 档案愿景

综合档案 = **多正交轴 × per-KC typed 状态 × 有向 KG 承重 × 校准不确定性 × 防编造缝**，绝不是一个标量能力数。teaching-team（conjecture engine + planning panel）消费它：正交轴给多个着力点（不是「不会」而是「过度求稳/过度自信」）；per-KC typed 状态把每个 fail 归类派不同处方；有向 KG 让图参与估计；校准不确定性告诉 panel 何时该信；防编造缝（A13）保证消费的是击败过量化 baseline、可追溯、不虚高的信念。

**n=1 litmus**：信号 admissible ⟺ 以已知常数 / 充分统计量 / owner 供给固定先验 / 单学习者自身状态进入；绝不是跨被试方差分量（a/slip/guess/φ）。

## §1 档案装什么（3 张新表）

* `kc_typed_state`(kc_id, state{mastered|confused-with-X|no-evidence}, confused_with_kc_id, lifecycle{open|remediating|resolved}, evidence_event_ids, confidence) — 单 writer = A13 loop；conjecture engine 最高频读面「哪些误解还 open」。
* `learner_axis_state`(drift_v, boundary_a, ter, calibration_curve_json, n_obs) — 单 writer = A11/A10 batch；慢变覆写。
* `open_diagnostic_log`(prompt, response, predicted_entropy_before/after) — append-only，A15。
* 现有表扩展：`theta_grid_json`(A4 网格后验)、`b_prior_sigma2`(A12 LLM 先验方差)、`kt_json.srt_d`(A1 时限，唯一非估计量软轨例外)。
* **软轨红线**：irt_a/irt_c/cdm_json 的 a/c/slip/guess 在 n=1 不可估，恒 NULL，绝不进 p(L)/调度。

## §7 分阶段路线（A1-A15 各一次）

| Phase | 方案 | gated-on | 状态（2026-06-19） |
| -- | -- | -- | -- |
| P0 前置 | YUK-432 | — | ✅ Done |
| P1 量化底座 | A1 SRT→A2 分层Elo+A3 KLP+A4 网格θ | YUK-432；drop-in | ✅ **LIVE**（SRT/HIER/KLP flag 已翻 #499/#500；A4 inc-2 grid→SoT 待，YUK-436） |
| P2 typed 失败 | A8 distractor→misconception+A9 step-grading | judge 校准；A8 schema | 🚧 **plan 落定**（重定性为「consume 已有 cause」，见 `docs/superpowers/plans/2026-06-19-p2-typed-failure-plan.md`） |
| P3 架构融合 | A12 先验→贝叶斯+A13 prediction-grounding(=教研团 Phase 0) | judge；P1 baseline | 待 |
| P4 KG 承重 | A5 图-Laplacian+A6 prereq 有向 | YUK-344+relation_type ADR | 待 |
| P5 效率/描述符 | A7 MEPV+A10 confidence+A11 谨慎轴 | usage-gated | 待 |
| P6 非短视/开放 | A14 DAD+A15 LLM elicitation | 模拟器保真度 | 待 |

## §8 诚实天花板

firm-up 永远不破：**难度尺度 anchor**（shift-invariance n=1 无解，只靠 owner 固定先验+active-PPI）、**per-item a/c/slip**（跨被试方差，LLM 侧 discrimination Spearman≈0.15 独立确认）。所有方案都是**已锚定模型上的乘数，不替代 anchor**。失败模式分两类：simulator-误设（A14/A15）vs prior-误设（A12/A13）。

## 关键连接

* **A13 ≈ 教研团 Phase 0 conjecture 引擎（YUK-406），build once**
* A1 gated YUK-432 · A5/A6 gated YUK-344 · A8/A9 复用现有 LLM 出题+judge
* 不是孤立新活，是把在飞/已做的串成承重结构。

## §9 P2 重定性 + UI 终局（2026-06-19 owner review 后补）

* **错因机制早已 live**：`attribute.ts`（LLM 读答案产出 `CauseSchema {primary_category, secondary_categories[], analysis_md}`，ADR-0006 event-chained）+ `mistake_variant.cause_category` + SubjectProfile 声明的 cause taxonomy（owner-fixed = admissible）。MCQ 与开放题**天然统一进同一条 judge-cause 归因链**（归因读文本，选项文本即输入）——`distractor→misconception` 框架（文献 MCQ 思路）废弃。
* **A8 核心 = 填 `candidate-signals.ts:283` misconceptionRecurrence slot**（per-KC cause 复发 tally，软选题信号，绝不进 θ）。
* **misconception 图实体（RT1，ADR-0036）是 owner envision 的 UI 终局**：claude design 知识点详情页有「指向此点的误区 · misconception」section（误区 pointing at KC + 「顽固的错误信念」）+「反向链接 · 按来源类型」。tally → 复发 ≥k 晋升 → RT1 节点 → 渲染该 section（晋升前显示空态）。RT1 hard-gated 在 ADR-0034 一致性闸（YUK-344）。
* **P1 也有 UI 家**：该详情页上半「成长 ladder（萌芽→成长→稳固→精熟）+ 硬轨校准·低置信 badge + 三维折叠为单标量·R 记忆·p(L) 掌握·difficulty 难度」= 已 live 的 P1 θ/p(L)/difficulty + 校准成熟度。
