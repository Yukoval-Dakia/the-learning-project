# YUK-1364 — TeachingBrief 正式发题与结果契约

## 缺陷和行为

旧 TeachingBrief 直接选择 legacy question，可能显示未正式发题的 probe；同一题提交会返回 `409 probe_not_issued`。测试中已用真实 route 和隔离 PostgreSQL 重现，不依赖已清空的私人旧数据。

选题现在要求存在正式 issuance、属于同一题组的 revision、admitted 且未 suspended/withdrawn 的生命周期，以及可投影的单一 open-response 契约。廉价资格过滤在候选窗口前执行，超过 50 条较新的未发题记录不会挤掉较旧合法题。题面来自冻结 issuance，保留提交端的 authored-snapshot 校验；GET 不补写、发布或修复旧题。

## 独立初审后的修复

初审发现 P1：active brief 使用冻结题面，而 completed outcome 校验仍读取可变 question。两条真实作答 route 回归重现：作答 200，随后 brief 为 null、ack 409、report 把合法结果计为 corrupt。

active 与 completed consumer 现在共享冻结题面投影。完成后的结果不重新要求当前生命周期仍可发题，合法 pre-issuance 历史结果保留原有语义；结果有效期和报告的历史窗口语义保持。正确/错误答案均覆盖作答、结果展示、确认和报告计数；后续停用、撤回、缺生命周期、题面编辑也有隔离回归。

## 验证证据

2026-10-07 首次 P1 修复后的记录（未覆盖下述连续复验缺口）：

- 7 个 scoped DB 文件、124 项测试通过，包含正式发题资格、完整结果链路及 probe-answer 消费者。
- 3 个 scoped unit 文件、52 项测试通过。
- typecheck、lint、build 日志完成；lint 为既有 297 warnings，无新增错误。
- 测试使用独立 Testcontainers PostgreSQL 和离线模型执行端，未操作 live loom、未调用付费 provider。
- 独立初审 P1 的红绿记录：`/tmp/yuk1364-p1-red.log`、`/tmp/yuk1364-p1-green.log`。最终回归：`/tmp/yuk1364-p1-db-final.log`、`/tmp/yuk1364-p1-unit.log`；其他门禁为相同前缀的 typecheck/lint/build 日志。

唯一验证审已完成，仍有一项 P1：带 follow-up 的连续复验通过 `probe-evidence.ts` 校验支持链，`supportingQuestionSequence` 仍读取可变题面、参考答案和版本。已正式发题的 legacy follow-up 编辑后，可能作答成功却使 confirmed 结果不可见、ack 409、报告误判 corrupt。该发现来自源码追踪；上述单次 probe 回归不能证明连续复验通过。

独占 implementation writer 正在用隔离 DB 复现并修复；PR #1591 暂不合并，不启动第三轮审查。父线程仍须检查实际修复和回归结果。此记录不代表 exact-head CI 已通过，也不代表该修复已部署。真实 provider 输出质量不属于本次离线契约验证结论。
