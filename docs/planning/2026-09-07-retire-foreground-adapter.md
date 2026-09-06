# YUK-965 — 退休旧 Copilot 执行适配器

## 范围与结果

前置统一会话已交付 main `9ebee3ae`。本变更执行 ADR-0062 的结构收口，
不改变已批准抽屉视觉，不修改生产数据、部署、SoT 或历史兼容政策。

- 删除没有产品调用方的 `server/chat.ts` 执行生命周期与进程内 mutex。
- 原输入/回复/教学原子提交函数保留在 `conversation-writes.ts`，真实调用方直接消费。
- `copilot-execution.ts` 不再暴露 foreground/single/stream 分支；同一持久取消、
  工具预算、根任务校验及 SDK 所有权规则适用于所有消息。
- 输入组装必需已接受的因果 anchor。删除仅旧入口使用的无 anchor/省略历史开关；
  原生 resume 编码仍省去模型重复历史，但校验/更正保持完整有界历史。
  真正缺失旧 anchor 的告警与兼容读取保留；错误 action/session 仍 fail closed。

## 验收迁移与保护

actual 脚本使用生产 HTTP adapter（非合成 reservation）、真实 v2 接纳事务、
物理 pg-boss fetch 的持久 payload 与 `runCopilotRun`。测试手动驱动取件、
终态后 wake 与 complete，以保留 SDK evidence capture；不冒充自动 poller。
原 unified 场景仍使用真实 Hono socket + manifest handler。

超时调用生产 Stop 并等待实际任务结算，不用 Promise.race 丢弃付费工作。
成功须满足：唯一 domain reply、唯一 REPLY/DONE、正确 task/session/因果根、
三处 reply/primary-view 相同；若有 reviewed DELTA，须位于 REPLY 前且字节相同。
还检查唯一非 partial SDK terminal、finalization receipt schema/hash 与已知费用来源。
五读取 claims 不允许靠重复调用集合去重掩盖额外读取。未知费用不是零。

## 测试替换映射

| 退休入口里的行为 | 保留的实际 owner 测试 |
| --- | --- |
| 请求枚举及非法 skill | chat-contracts.unit + API chat.unit |
| 历史裁剪、header、反馈隔离、读取失败 | copilot-run-input.unit；因果/legacy 锚由 DB suite 负责 |
| marker 清理及 HTML 尾部边界 | legacy-primary-view.unit + reply-finalization.unit |
| validator 拒绝/AbortError、终稿回退、预算 | copilot-execution.unit + content-validation.unit |
| 教学题目与回复原子提交 | teaching-skill.db + copilot_run.teaching.db |
| 根执行、工具活动、原生会话、Stop、重放 | copilot_run.test + subagent-mailbox.db + cancel-run.db |
| 会话创建/持久发送/FIFO/丢响应恢复 | API contracts.db + durable-session-queue.db |
| 历史回复及撤回资格 | turns.db（保留26项，删除仅旧入口组装用例） |

只删旧生命周期及其重复断言；原数据迁移、计费、权限、parser、rollback 与恢复保护不按数量裁减。
输入测试 lane 初版有常量断言/名不副实 fixture，root 要求改成真实裁剪、污染字段与 anchored seam 后才合入。

## 验证状态

- 143 tests / 10 scoped DB files 通过。
- 122 tests / 8 scoped unit files、typecheck、Biome、build、capability/architecture/partition audit 通过。
- 两项零付费运行通过：cancel 走生产接纳、Stop、物理 pickup 后 cancelled；
  unified admission-only 验证两消息一个物理 head 与无活动残留。
- raw evidence：`.tmp/actual-provider-acceptance/1788721088198-1711cb44-4cae-4aa9-9431-e3d8bff1ea48.json`；
  `.tmp/actual-provider-acceptance/1788721121954-05bc4d25-6477-4650-bc01-81c002281d90.json`。
- 依赖基线 439→438 仅来自旧 session 调用消失；无新增豁免，仍有五模块 SCC，不能用审计绿代替全项目完成。
- 独立 review、exact-head CI 与 merge 尚待；未部署。

## 实际输出与预算

一条 read 实际输出已在 clean exact `88a4a60314f2c9be5d4840d5da7caed041acb008` 通过。
证据见 [封存输出](evidence/2026-09-07-retired-adapter-read-actual.json)。一个根任务，
一个真实 query_knowledge 调用（SDK 与 domain 各一条 trace，不是两个工具执行），
终稿准确保留「文言虚词「之」」「代词宾语用法」及父子关系，未声称空结果不存在。
SDK terminal 非 partial，candidate/reply/terminal 三个 digest 相同；持久回复与公开终态断言通过。
模型输入26951/output177，不以这条不同链路样本声称可比 token 降幅。
公开 USD 卡估算0.0006681774，非账户账单；保守预留 USD0.25 不回收。
新 USD10 池 reserve 5.55823、安全剩 4.44177，累计 estimated USD0.0359138701；
旧池0.28771982单列，历史未知费用仍未知。无需重刷已封存的压缩、教学、成品和恢复付费样本。

本次发现与修复均归入已去重的 YUK-965；没有新增需另开 issue 的独立问题。
