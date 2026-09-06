# 当前 handoff — 2026-09-06（完整重构goal active，YUK944）

Owner 已授权 AI pipeline 与基于1e61da8d报告的全项目业务封装/测试精简。
原始the-learning-project脏main保持不动；此handoff在隔离tlp-wt-test-pruning工作树。

## 当前实施（优先于下方历史完成记录）

- goal active；主线9427202c，分支codex/yuk-944-context-contract，草稿PR1338不可合并。
- remote3a735ffc exact CI Gate34027572879全绿；local7b3919d5未推，当前 comparison_guidance 待提交。
- typed reader v2 拥有 claim 边界、事件/作答可用性、focal/direct-child范围和确定性 observed_edges。
  不新增query、bridge或evaluator；TaskSpec/Skill只保留导航，禁止重新堆叠重复规则。
- 六次candidate均未完整语义通过。第六次7b3919d5：70.324s/$0.191851，终文可见且全部七条
  直接边正确；仍把B其他事件未知写成无、称唯一差异。
- 原主线受控baseline a1f72e94（/tmp/tlp-claim-baseline.yuNFPU，base9427202c，仅测试harness
  与90s窗口变更）：64.173s/$0.209183，仍漏认跨subject，但正确限定B/C已观测直接分叉。
  报告证明问句标题还会误触学习校验；免费确认当前检测仍为true，未降低真实题目保护。
- 当前将原主线有效 comparison 指引放入唯一 typed 合同；13DB/typecheck已通过。
  完成unit/lint/build及提交后，用相同五读取/模型/90s做一次组合验证；不能结构绿冒充语义绿。
- 944 candidate+baseline累计 $1.15308718（首轮估算、其余reported），含owner追加$1后余额
  $0.45174082。所有输入/输出/hash/root run/model/cost见2026-09-06-claim-context-actual.json。
- 内容表格3-step数据误判已红绿修复，observed_edges 13DB+22unit/typecheck/build/lint通过。
- review_claim_context初审P1已修，唯一验证审通过但非语义验收；不再启动第三轮。
- 946 Done：离线native SDK首请求catalog有/body无，调用Skill后body才出现，付费0；
  不重建目录、不移除现有quiz可见性。SDK0.3.220原生compact/reinject仍属945未实现。
- 945/948/949/950与全项目业务封装仍须完成，951需部署后drain证据，887需生产副本授权。

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
  946按原生能力验证Done；944/945/948/949/950未完成。YUK921/572/832 HOLD不解锁。
