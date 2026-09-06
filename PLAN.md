# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-06：业务完成责任与测试精简已收口，客户端与生产迁移边界保留。

## NOW

- Owner 授权 AI pipeline、全项目业务封装与测试精简；不把目录归属或 audit 数量当整体完成。
- AI finalization #1326、Goal #1327、Knowledge merge #1328、Ingestion completion #1329、
  ReviewSettlement #1332、测试精简 #1331/#1333 已经各自 exact-head CI 绿色并合并。
- YUK-954 #1330：共享执行 owner，权限/校验/取消/原生子代理规则一份实现；
  隐藏 child 终态结算已红绿复现并修复，唯一验证审 APPROVE；已合并main9302f08b。
- YUK-958 #1334：后端成功 quiz 显式 end，失败/取消/blocked 不结束；
  inline、durable、marker repair、replay 共用产品状态，不增加模型输入。
  独立 review、exact-head CI 绿色并合并main dce62f79；UI 尚未修改，不能关闭整票。
- 当前main dce62f79重新实测依赖基线438/0/47（此前98f15bda为439/0/47）；
  五 capability SCC 与20个命令消费者仍在，未宣称消环。
- 实际输出：同输入 read 样本 input 至少降50.8%、费用至少降62.2%；仅限 synthetic。
  共享执行层新增实际回归$0.146376，本次增量合计$0.395172，剩余授权$0.604828。
  历史未计价超时/child仍未知；durable actual不是queue E2E。
- Linear 939/940/941/942/952/953/954/955/956/957/959 Done；943/947为设计替代而Canceled。
- 详细责任、验证与剩余边界见 docs/planning/2026-09-06-business-architecture-closeout.md。
  原始 the-learning-project 脏main始终保留，所有改动在隔离工作树。

## NEXT

1. 后端集成交付已完成；不部署，不重复已完成的模型验收。
2. YUK-958（待批准）：UI预检获批后，客户端消费显式结束状态，统一前台/后台消息投影，
   删除按技能名猜测终态的补丁；保持原drawer外观与失败恢复。
3. YUK-887：获得独立生产副本/部署授权后，逐实体提供backfill/audit/rebuild/golden证据，
   再决定SoT兼容分支退休；不能从本机默认开关推断生产状态。
4. 每PR最多初审+一次P0/P1验证审；954预算已用尽，958初审通过。

## PARKED

- 944/945/946：剩余prompt精简、transcript compact、skill可见集优化；不将whitelist
  误认作每轮eager body加载。949 primary_view marker、950 live steer未实现。
- 948显式Mission API入口迁移仍待后续；当前durable由显式请求触发，不自动后台化根请求。
- 951历史mailbox/ToolOperations仅drain-only恢复；退休需零pending/零队列活动跨完整重试窗口。
- YUK-921多provider、572夜间教研、832 HOLD未解锁。
- 保留计费、重试、prompt/skill、富结构解析、并发/回滚/恢复、UI加载安全测试；不按数量硬删。

## BLOCKED-ON

- YUK-958 UI需要owner对已提交的设计原文、drawer类型和精确文件清单批准。
  待改CopilotDock/subtask-events/replay/skill-lifecycle及测试，新建message-projection及测试。
- 生产clone验证、部署、SoT flag切换与历史数据删除均无授权，未执行。
