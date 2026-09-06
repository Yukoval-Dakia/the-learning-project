# AI pipeline 与业务封装验收

本轮以业务行为而非文件搬迁为单位收口。原始脏工作树未覆盖，未部署或修改生产数据。
逐项实现与 exact-head CI 由以下 PR 留存；不能把这些代码验证称为生产验收。
基线快照：main `98f15bda` 为439/0/47；#1330合并后main `9302f08b` 重新审计为438/0/47。

| 行为 | 唯一协调责任 | 收入内部的共同规则 | 验证入口 |
|---|---|---|---|
| AI 根执行 | Copilot execution owner | 工具权限、关联、子代理、内容校验、取消与最终回复封存 | #1326、#1330 |
| 目标变更 | Agency Goal commands | 创建、状态、范围、撤回、事件和 legacy 兼容 | #1327 |
| 知识合并 | Knowledge 事务协调器 + 各状态 owner | Practice 归因、Agency 范围、误区碰撞等由各自命令处理 | #1328 |
| 录入完成 | Ingestion completion command | 源卡锁、导入、归属、终态回执与重复投递恢复 | #1329 |
| 判分完成 | Practice 的三个 settlement commands | FSRS、掌握度、证据、回滚快照、提交后信号 | #1332 |
| 模式结束 | Copilot mode-completion contract | 成功 quiz end、失败不结束、durable/replay 一致 | #1334，后端部分 |

知识合并仍需要跨业务事务；改善点是协调器不再直接修改题目、学习项和目标的内部表。
录入的业务数据与操作完成回执在同一事务内提交。判分的三种入口共用学习效果实现，
保留各自的模型调用与队列生命周期。目标的旧数据兼容留在负责人内部，入口不再各自选路径。

## 实际输出和费用边界

已封存 cold/resume/ambient/read/proposal/correction/cancel/native/durable/semantic
命名 synthetic 场景。共享执行层另做语义拒绝与同步子代理的真实模型回归：
新增报告费用 $0.146376；本次增量 campaign 合计 $0.395172，剩余授权 $0.604828。
早前未计价的超时/中断调用仍是未知，不能算作 $0。

同输入 read 样本从旧链路至少 57,817 输入 token / $0.201614，降到新链路
28,464 / $0.076271：至少降低 50.8% / 62.2%。旧基准含未计价超时，因此是下界，
不能外推所有任务或生产平均值。durable actual 直接调用 handler，不是队列 E2E。
详细 revision、输入输出 digest、run ID、provider/model 与费用见版本化 evidence JSON。

## 测试精简

删除已退休 evidence 模型链的内部测试、重复执行装配断言，以及 capability/Notes
搬迁后的路径扫描；原生 Task 接线改查真实执行上下文。未按数量硬删场景。
全项目结构盘点涵盖 AI、kernel、subjects、UI、capabilities 与 integration，
详见 test-pruning-evidence / test-pruning-census；不宣称逐条人工复核了全部断言。

保留权限、计费未知、paid retry、富结构解析、并发、回滚、late-result、取消、恢复、
模型实际输出及 UI 加载保护。CI 暴露旧 owner guard 时更新真实负责人或显式状态，
没有通过增加豁免、抬高阈值或删掉单写入保护来过关。

## 尚未完成的边界

- YUK-958 客户端：等待精确 drawer/file 设计预检批准。后端新增明确状态，但尚未
  删除 CopilotDock 的 one-shot 补丁，也未合并两种传输的消息展示投影。
- 逐实体 SoT 迁移退休：需要生产副本上的 backfill/audit/rebuild/golden 证据与授权；
  本轮未翻生产开关、未删除历史表和事件。
- 历史 mailbox/ToolOperations drain-only 恢复器：需部署后零 pending、零队列活动
  覆盖最大 deadline/retry 窗口，才可删除。当前不是活跃的第二套生产者。
- 五个业务 capability 的依赖环仍存在；438/0/47 的依赖基线下降不是消环或整体架构完成证明。
- transcript compact、live steer、primary-view marker 退休及 Mission API 入口迁移
  仍在原 Linear backlog；没有把当前封存执行方案等同于这些新产品能力已实现。

旧 YUK-943 非 claim token 提前展示、YUK-947 强制 canUseTool 机制已被锁定的
finalization design 替代，标为 Canceled 而非伪称实现完成。YUK-942 产品配置隔离已完成。
