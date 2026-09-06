# 当前 handoff — 2026-09-06

Owner 已授权 AI pipeline 与基于1e61da8d报告的全项目业务封装/测试精简。
原始the-learning-project脏main保持不动；此handoff在隔离tlp-wt-test-pruning工作树。

## 完成与验收

- Pipeline1326、Goal1327、Knowledge1328、Import1329、Copilot execution1330、
  ReviewSettlement1332、测试精简1331/1333均已exact-head CI绿色并合并。
- main dce62f79已实测438/0/47；5capability SCC与20命令消费者仍保留，不称消环。
- Goal集中command并保留私有legacy兼容；知识合并各owner处理状态、单向命名adapter；
  Import业务提交与operation receipt同事务、并发source锁；Review三个命令共用学习效果/恢复。
- 954隐藏native终态P1红绿复现并修复，root和独立15DB通过；其两轮review预算用尽。
- 958服务端mode completion完成初审+scoped gates；647882b4 PR1334最终CI绿色并合并dce62f79。
  该head后端等于已全绿2089b0ce，仅含主线已验证Notes测试/文档合并差异。
- Docs handoff PR1335已更新1334合并事实，exact CI是合并门；不部署。
- 客户端PR1336 exact0581aab529a643d4c6837dc382ef831452846a24的CI Gate34015722399
  所有分区绿色，已合并main92ed46452b9af726cf09d64d360fae80e755fb3f。YUK958整票完成。
- 全项目测试结构盘点保留计费、retry、prompt/skill、复杂parser、并发/回滚/恢复与UI加载保护；
  删除旧路径/重复装配/退休evidence链内部断言，不按数量硬删。

## Actual与费用

本次追加共享执行层semantic/native actual费用$0.146376；增量campaign合计$0.395172，
剩余授权$0.604828。此前$0.503605与旧read下界之外的未知超时/child账单仍未知。
同输入read样本input至少降50.8%、费用至少降62.2%；只限synthetic，不外推生产。
Evidence在docs/planning/evidence/2026-09-06-{pipeline,copilot-execution}-actual.json。
durable actual直接handler不是queue E2E。无需更多付费验证。

## 下一步与禁止项

- 958 UI已获owner「继续」批准并实施：CopilotDock/subtask-events/replay/skill-lifecycle
  共用message-projection；只有权威REPLY+明确end结束模式，失败保留重试。无视觉变化。
  116 scoped tests、生产bundle inline/durable发送→后续发送→reload回放2条流程已通过；
  草稿+DONE无REPLY的P1红绿复现修复，唯一验证审PASS。最终整组15条浏览器流程与CI全绿；
  已合并#1336，不再等待客户端实施。单独docs closeout仅对齐交付状态。
- SoT最终退休需要单独生产副本backfill/audit/rebuild/golden证据与授权（YUK887）。
- 不部署、不切生产flags、不backfill、不删历史数据/表；旧mailbox/ToolOperations仅drain-only，
  退休需部署后零pending和零队列活动跨完整deadline/retry窗。
- Linear已恢复；942 Done；943/947是锁定设计替代而Canceled；951保留drain/noun剩余Backlog。
  944/945/946/948/949/950未虚假标Done。YUK921/572/832 HOLD不解锁。
