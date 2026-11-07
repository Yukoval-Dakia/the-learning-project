# ADR-0080 — Coach 统一安排与带理由的练习队列

**Status**: 已决定，尚未实施（2026-11-07）
**Partially supersedes**: ADR-0042（规划、抽样与顺序限制；MFI等确定性信号保留）
**Amends**: ADR-0037 决定 3 的到期硬约束
**Related**: ADR-0028（FSRS 确定性层保留）、ADR-0043（标定数值契约保留）、ADR-0075（执行与恢复）、ADR-0078/0079（备题与准入）
**Tracking**: Refs YUK-1790；Refs YUK-1780。审计根项：Owner 目标总账 19、21；交付阶段为设计决定，候选读口和产品切换尚待实施。

## 背景

当前 Coach 写今日重点，选择器又以模型权重和随机抽样排题，作答后只按统计重抽。候选分档投影不含题面和知识点名称（`src/capabilities/practice/scheduling/server/selection-orchestrator.ts:73-105`）；当前默认仍是 softmax_mfi（`src/core/config/registry.ts:514-519`）。源码基线为 `2a15d26a53a61a21ab9143fa43d46ffb4ef8c283`；本 ADR 不声称运行路径已切换。

Owner 与协调已决定由一个 Coach 排带理由的队列。YUK-1780 评论 `1108c99f-6f14-428c-bbaf-ddffb2f4cc6a` 撤销“重点与单题分别规划”；YUK-1790 评论 `0571a210-5eca-42ab-a330-76d75016a263` 确认无新 flag、一次切删、coach_queue 权重 1.0。完整设计中的代码证据与设计推断分开列示。

## 决定

1. **Coach 是唯一规划者**。真实可服务候选、真实数值与允许读取的 Context/Steering 输入同一次规划，输出整体意图、队列顺序、逐项理由和到期推迟记录。TodayPlan 重点退为同一队列版本的只读投影，不保留第二份可写计划。目标建议沿既有提议/接受权限、去重与冷却，不因规划而自动成为目标。
2. **取题与物化仍确定性**。学习方向拥有Coach判断，学习会话拥有due/候选组合、queue/revision版本及流项、草稿与领取。nextItem是待建幂等写命令，held是待建typed返回，不是现有status；issuance到stream item的持久绑定、非空partition_key唯一性及日流首次创建partition锁须同片实现。CAS 提交与物化差量同事务；正在做、已做、已领取或有草稿的项保持身份和题 revision。候选失效、用途拒绝、Steering 变化或版本冲突以 typed 拒绝在同轮修复，不先删当前队列。
3. **到期可有理由推迟，FSRS 数学不动**。废止 ADR-0037 的到期必入队/相对序硬约束；Coach 对快照内到期候选逐项说明选择、推迟、阻断或冻结，积压和可提取度持续可见。无模型fallback也必须对时间预算/容量等裁切逐项产出并持久化deferral，不能仅返回kept或deferredDueCount。推迟不写 FSRS dueAt，不伪造作答或掌握证据。FSRS 的间隔、到期与可提取度计算继续由确定性层拥有，ADR-0028 的单 writer 不变。
4. **硬事实由服务端执行**。题目存在、当前准入与用途、原题重背/换题、去重、容量和已获授权的明确 Steering 由候选读口、commit 与 nextItem 一致验证。未知信号保留未知；模型不能自造授权。缺题向备题员异步发单，未准备好的题不可占可出题队列。
5. **下一题不等模型**。无队列或 Coach 失败、取消、崩溃时，用保留的 `composeDailyStream` 确定性核心继续；后台准备好后只替换可变部分。不再有统计抽样 fallback，不新增 flag，不长期双写。Steering/用途无法核实时保留安全拒绝，不能用无约束 fallback 绕过。
6. **新来源显式记账**。仅Coach实际放置的普通流题记 `coach_queue`、π=NULL、已批权重1.0；确定性fallback到期题保持 `due`、π=NULL、0.8，其余fallback普通流题沿原确定性来源口径，不整体升权。既有项只调序不改最初placement来源。既定数学和常数不变；容器证据优先级不变。Coach新来源不能落入旧 `calibration-evidence.ts:61-94` 的 due 兜底，也不能进入 `joint-replay.ts:274-279` 的 softmax legacy NULL→0.5/IPW 分支。历史来源、π、NULL 回放语义原样保留。停写前必须通过固定历史输入的 `replay:joint-calibration` 两revision对照与生产joint批来源/数值对账；未取得证据禁止FULL切换，不能以NOT_RUN交付。通过后停止 selection_observation 新写，表、备份与恢复兼容留给迁移 DROP 窗口，未完成往返与历史对账不删。
7. **分两片交付**。LIGHT 硬依赖新准入门，新增注册coach context view；掌握/证据量/保留度/连续错/top错因只消费功能线YUK-1969/1970内部读模型，允许known:false；只交真实候选读口与该view，不写队列、不长期影子运行；FULL 同片转移重点/目标建议/队列并删除 SelectionOrchestratorTask、softmax、sampler、作答后重抽及所有入口与配置引用。旧在途付费效果先排空或有持久化恢复，unknown 不自动重发。probe 暂维持现状；prepare_intervention 保留。产品切换不等待重组批6搬目录。FULL从排队工具面移除可读reference的get_question_context并关闭其他工具旁路；queue/revision与issuance绑定表必须进FK_ORDER、bump备份SCHEMA_VERSION、补rehearsal并通过往返验收。回滚只允许理解新来源/绑定的兼容版本，旧二进制须由release兼容gate阻止。

## 后果与备选

放弃旧“模型给权重、随机抽样兜概率”的结构，代价是不能再声称新队列具有旧抽样 π 或以 IPW 校正其选择偏差。可解释队列也不证明学习有效；推迟复习的质量要从真实使用判断。纯确定性组合保留为承重 fallback，不能被删除或降级为静态示例。

拒绝双规划者长期并存、逐题等待模型、模型改 FSRS 间隔，以及只删 observation writer 却把Coach新来源归 due，或把fallback既有due证据升为1.0。真实对照须冻结同一状态，保留错误输出、revision、输入输出摘要、task-run、provider/model/cost；一次成功只证明该次路径行为。

## 实施合同与验证边界

完整设计（含给 Owner 的一页、五个合同、逐 consumer 表、切片写集与删除面）：
`/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-07-yuk1790-coach-queue.md`

SHA256：`7d33319a7893505a0004f19da227b72fa474a6fdbf94cb4c43483eec7c7c5539`。

代码现状的依据见设计 E1–E9及D4；恢复、并发与学习者可见行为是待实施合同。现有数值 parity 文件仅定位，未运行且未证明覆盖新来源。没验证的：真实模型输出/费用、队列运行、数据库历史 π/回放、备份恢复、草稿/held/结束、下一题延迟和学习效果。本轮不运行构建、dev、数据库、TEST或模型；设计与 ADR 不构成产品验收。
