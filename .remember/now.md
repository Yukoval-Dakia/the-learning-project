# 当前 handoff — 2026-09-06（完整重构goal active，YUK944）

Owner 已授权 AI pipeline 与基于1e61da8d报告的全项目业务封装/测试精简。
原始the-learning-project脏main保持不动；此handoff在隔离tlp-wt-test-pruning工作树。

## 当前实施（优先于下方历史完成记录）

- 完整目标仍active，不能以958或当前切片替代。验收契约见2026-09-06-refactor-completion-contract.md。
- main9427202c；active branch codex/yuk-944-context-contract，尚未推送/开PR。
- 944将claim完整定义留typed reader，TaskSpec证据2105→282chars、skill9735→4901；工具description精简。
- 83 registry/skill unit+19 finalization/content unit+26 reader DB、typecheck/build/audits通过。
- 首次actual04e9b83e五read完成但无权威终文，旧harness错误返回ok；第二次af811146修正门后正确失败。
  第二次root status=failure/finishReason=error；免费转录诊断见61.792s迟到正文，超过60s预算，
  但SDK错误子类型未捕获，不声称已证明精确原因。该正文还错误断言B无rate/唯一差异。
  已补typed比较/缺失/outcome边界，任务时限90s与既有请求上限一致，保留6轮及绝对deadline保护。
- 两次费用分别estimated$0.02766318、reported$0.148581；最新剩余授权$0.42858382。
  版本证据2026-09-06-claim-context-actual.json；停止无诊断付费重试，不缩小五read质量要求。
- reviewer review_claim_context初审2P1均属harness：额外tools未隔离、缺失reader未在付费前检查；已修。
  另已要求claims显式budget、拒绝无terminal/额外model/tool，并新增SDK安全子类型/耗时记录。
  唯一验证审已通过（不代表模型质量通过）；不能开第三轮。SDK agent原生压缩结果仍需实现验证。
- SDK0.3.220据本地类型有原生autoCompactEnabled/autoCompactWindow、Pre/PostCompact、boundary metadata、
  streaming prompt/streamInput；没有公开compact()。不得据文档推断实际enabled或原因。
- 下一步：验证harness修复，核对原生SDK终止/压缩与现有6iterations/60s控制，再处理944/945/946依赖；
  不新增第二套skill catalog/summary系统。948/949/950与剩余业务封装仍须做；生产权限边界仍保留。

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
当时剩余授权$0.604828；944两次后当前余额$0.42858382。旧未知超时/child账单仍未知。
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
  944/945/946/948/949/950未虚假标Done。YUK921/572/832 HOLD不解锁。
