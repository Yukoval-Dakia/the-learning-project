# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-06：完整重构目标持续推进，当前 active 为 YUK-944 证据规则单一权威与上下文降本。

## NOW

- Owner 授权 AI pipeline、全项目业务封装与测试精简；不把目录归属或 audit 数量当整体完成。
- YUK944 active：typed reader 是 claim 合同唯一权威，reader v2 分离事件与作答可用性，
  明确直子覆盖、确定性 observed_edges；同查询不新增模型层。TaskSpec/Skill 删除重复规则。
  六次 candidate 和一轮原主线受控 baseline 均未完整验收；累计 $1.15308718，余额 $0.45174082。
  第六次7b3919d5正确列出跨对象直接边，但B/C仍把未观测写成“无”、断言唯一差异。
  baseline a1f72e94 同样漏认跨对象事实，但比较约束更准确；现将其指引仅恢复至 typed 合同。
  原主线报告问句标题还会误触学习内容拦截，未修；保留无标签真实学习题的保护。
  13DB/typecheck 已过；继续 scoped unit/lint/build，提交后仅做一轮同样本组合验证。
  草稿PR1338：remote3a735ffc exact CI Gate34027572879全绿；本地7b3919d5及后续尚未推。
  独立初审及唯一验证审预算已用，不启动第三轮；语义质量未过，不合并、不关闭944。
- AI finalization #1326、Goal #1327、Knowledge merge #1328、Ingestion completion #1329、
  ReviewSettlement #1332、测试精简 #1331/#1333 已经各自 exact-head CI 绿色并合并。
- YUK-954 #1330：共享执行 owner，权限/校验/取消/原生子代理规则一份实现；
  隐藏 child 终态结算已红绿复现并修复，唯一验证审 APPROVE；已合并main9302f08b。
- YUK-958 #1334：后端成功 quiz 显式 end，失败/取消/blocked 不结束；
  inline、durable、marker repair、replay 共用产品状态，不增加模型输入。
  后端独立 review、exact-head CI 绿色并合并main dce62f79。
- YUK-958客户端：owner已批准，inline/durable/replay共用终态投影和显式模式状态；
  草稿不能冒充权威REPLY。116 scoped tests及2条生产bundle Copilot流程通过；
  初审P1已红绿修复，唯一验证审通过。#1336 exact0581aab5全绿，合并main92ed4645。
- 当前main dce62f79重新实测依赖基线438/0/47（此前98f15bda为439/0/47）；
  五 capability SCC 与20个命令消费者仍在，未宣称消环。
- 实际输出：同输入 read 样本 input 至少降50.8%、费用至少降62.2%；仅限 synthetic。
  共享执行层新增实际回归$0.146376，截至958增量合计$0.395172；944后余额以上述最新账本为准。
  历史未计价超时/child仍未知；durable actual不是queue E2E。
- Linear 939/940/941/942/946/952/953/954/955/956/957/958/959 Done；943/947为设计替代而Canceled。
- 详细责任、验证与剩余边界见 docs/planning/2026-09-06-business-architecture-closeout.md。
  原始 the-learning-project 脏main始终保留，所有改动在隔离工作树。

## NEXT

1. YUK-944：补齐typed合同并核对执行窗口后，完整actual仍待过；修复跨读取证据合成/过度断言后再验。
   未取得真实终文质量证据前不合并、不关闭944。SDK原生长会话压缩仍属945未完成。
2. YUK-946离线native SDK验证通过：首请求仅catalog，Skill调用后才出现body，真实模型费用$0。
   原eager-body前提已否证；不重建目录、不删除free-form quiz能力，不声称移除正文带来普通轮降本。
   946已按原生能力验证收口Done，不代表实现了新目录或验证了生产模型选择。
3. YUK-945同session compact/reinject→YUK-949成品选择→948显式Mission入口→950同轮steer。
   UI步骤另按设计预检；后端与纯测试可继续。不得用结束一个PR代替整个goal完成。
4. 全产品复核学习意图→录入→判分→掌握度/复习→提议/撤回的所有者和扩展成本；
   消除剩余有害写依赖与双规则，替换重复测试，按实际行为与扩展压力验收。
5. YUK-887生产副本backfill/audit/rebuild/golden与SoT退休需要独立授权；不阻断安全的实现工作。

## PARKED

- 944/945/948/949/950已列入NEXT的完整重构顺序，尚未完成，不再作为无限期PARKED；946已验证收口。
- 951历史mailbox/ToolOperations仅drain-only恢复；退休需零pending/零队列活动跨完整重试窗口。
- YUK-921多provider、572夜间教研、832 HOLD未解锁。
- 保留计费、重试、prompt/skill、富结构解析、并发/回滚/恢复、UI加载安全测试；不按数量硬删。

## BLOCKED-ON

- 本轮没有未决UI设计门或CI阻塞；开放backlog不因本轮交付而虚假关闭。
- 生产clone验证、部署、SoT flag切换与历史数据删除均无授权，未执行。
