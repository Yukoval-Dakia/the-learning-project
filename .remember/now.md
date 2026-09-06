# 当前 handoff — 2026-09-06（完整重构goal active，YUK944）

Owner 已授权 AI pipeline 与基于1e61da8d报告的全项目业务封装/测试精简。
原始the-learning-project脏main保持不动；此handoff在隔离tlp-wt-test-pruning工作树。

## 当前实施（优先于下方历史完成记录）

- 完整goal active；main9427202c，当前codex/yuk-944-context-contract，PR1338待最终exact CI。
- c03b5b3e 五固定读取actual核心检查通过：正因果边、非穷尽/非唯一比较、激活策略未知、
  队列unknown非zero、具体ID/数值、权威终文展示、只有5reads/1model。不是生产或queue E2E。
- 79.098s；input40410/output3179；$0.164021 reported；root copilot_task_cywdi90plz9kxagie1jkn6rv。
  对照原主线input40401：此复杂样本没有token下降证据；不外推单样本费用或稳定性。
  redacted组数未明确endpoint，证据保留此精度局限。原六candidate和baseline失败记录不删除。
- 当前累计944 candidate+baseline $1.31710818，owner追加$1后余额$0.28771982；低于0.30reserve，
  不新增付费调用。evidence在2026-09-06-claim-context-actual.json，包含全输入输出/hash/cost。
- typed reader v2集中事件/作答可用性、focal直子/未查孙树、确定性observed_edges；原比较指引
  恢复到唯一typed合同，TaskSpec/Skill仅导航。无新增DBquery/bridge/evaluator。
- 内容表格3-step数据误判已修；原主线报告证明问句误拦未修，已登记YUK960。
  不按A01/fixture白名单或全删标题降低真实题保护；后续与949产品成品责任一起推进。
- 13DB+22unit/typecheck/lint/build通过；review初审与唯一验证审完成，不启动第三轮。
  上一remote3a735ffc exact CI34027572879全绿，最终封存需新的exact CI；尚未合并/部署。
- 946 Done：离线native catalog→调用后body验证，付费0，不重建目录或移除quiz能力。
- 945只读接线检查完成：runner.buildQueryOptions和consumeSdkAttempt是统一seam；SDK0.3.220
  有autoCompactEnabled/window、Pre/PostCompact和compact_boundary，但未接线；无公开compact()。
  PostCompact未声明additionalContext，不凭类型猜测注入，需要原生离线运行验证。
- 945/948/949/950/960与全项目业务封装仍须完成；951需部署后drain，887需生产副本授权。

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
