# 当前 handoff — 2026-09-06（完整重构goal active，YUK945）

Owner 已授权 AI pipeline 与基于1e61da8d报告的全项目业务封装/测试精简。
原始the-learning-project脏main保持不动；此handoff在隔离tlp-wt-native-compaction工作树。

## 当前实施（优先于下方历史完成记录）

- goal active；当前 /Volumes/YukovalSBak/yukoval-projects/tlp-wt-native-compaction，
  branch codex/yuk-945-native-compaction，PR1339 exact821184ac CI34031520139全绿，仍draft未合并。
  本handoff在该head之后仅补证据/状态，未推；产品代码与已复审18702ab9相同。
- 944 Done：PR1338 exact3fd90c4d CI34030191329全绿，2026-09-06T11:44:48Z合并main db5a57b1。
  c03b5b3e五读取actual核心checks通过、权威终文可见，79.098s/$0.164021；input40410 vs baseline40401
  不证明token下降。原六candidate和baseline失败均保留；报告问句误拦开放YUK960。
- 944累计$1.31710818，owner此前追加$1后余额$0.28771982；低于reserve，不再新增付费调用。
  已询问945真实压缩/事实保留/同session续聊是否额外允许最多$1，待答复；免费工作继续。
- 945接线：Options.settings autoCompactEnabled=true/precompute=false，仅foreground。
  原caller hooks后追加SessionStart(compact)，重新注入结构化当前context；空context返回空。
  learner每轮保留，proposal保持digest；cold/durable历史行为不改；codec v2。
  consumeSdkAttempt收到compact_boundary→terminal collector→usage_json bounded count/last
  （trigger/pre/post context tokens），禁止原摘要/CoT/消息IDs；不扣减billable tokens或重置预算。
- 初稿0f011b4d被独立初审两P1否决（顶层Settings/hook覆盖），root18702ab9已红绿修复。
  root143scoped tests/typecheck/lint/build通过；唯一复审PASS，独立137tests，不再第三轮。
  945最终代码CI已过；仍未真实模型摘要验收，不能合并或关闭945。Linear已同步In Progress。
- SDK0.3.220零费用loopback实测：PreCompact(auto)→SessionStart(compact)→PostCompact；
  session1526e361-1fd6-4046-a94d-8812a3d2300e compact与resume两次success；后续请求有注入状态，
  新turn有更新learner状态。185065→458是人为usage，不是token节省。证据JSON已在docs/planning/evidence。
- 946已Done原生catalog→调用后body验证，不重建catalog/移除quiz。
- 剩余945/948/949/950/960和业务整体验证继续；951drain/887生产副本仍需独立授权。
- 对SCC新增只读复核：learning-intent已有acceptLearningIntentOwned事务与owner失败全回滚测试，
  不把正常跨owner命令装配再次判缺陷；quiz_verify的coach pool-gap具体note/expiry规则尚留在Practice，
  已去重登记YUK961作为后续有边界的业务封装点，未实施。
- SDK settings源码schema限制autoCompactWindow为100000..1000000，非法小值catch(undefined)。
  免费probe：window20000/usage25000没有compact；window100000/usage95000触发compact并同session续聊。
  后续actual不得用静默忽略的窗口假称压缩，也不能把这些人工usage当真实token节省。

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
当时剩余授权$0.604828；944最新余额以上方当前实施为准。旧未知超时/child账单仍未知。
同输入read样本input至少降50.8%、费用至少降62.2%；只限synthetic，不外推生产。
Evidence在docs/planning/evidence/2026-09-06-{pipeline,copilot-execution}-actual.json。
durable actual直接handler不是queue E2E。完整goal的944真实质量验证仍未通过。

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
  944已交付、946按原生能力验证Done；945/948/949/950/960未完成。YUK921/572/832 HOLD不解锁。
