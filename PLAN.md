# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-06：完整重构目标持续推进，当前 active 为 YUK-944 证据规则单一权威与上下文降本。

## NOW

- Owner 授权 AI pipeline、全项目业务封装与测试精简；不把目录归属或 audit 数量当整体完成。
- YUK944 active：prompt证据段2105→282字符、skill9735→4901；83unit/11DB/build通过。
  前两次完整五读取actual无权威终文；第三次8c280cae获得终文，但跨subject正事实自相矛盾、
  仍有唯一差异过度断言；第四次a8cfd734仍语义失败（含虚构孙事件），不再逐句加词付费重试。
  944累计$0.55359018（估算+reported）；含owner新增$1，当前余额$1.05123782。
  已补typed比较/缺失边界，移除内部60s截断、保持90s请求上限和6轮；第三次耗时89.573s，
  不称稳定延迟达标。下一步先查实际上下文与reader表示，须有实质修复再付费验证。
  本次173 scoped unit/11 reader DB、typecheck/build与lint ratchet通过；不代表actual质量通过。
  夹具初审P1和终文假绿门已修，唯一验证审通过（不是语义质量通过）；不追加第三轮。
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
- Linear 939/940/941/942/952/953/954/955/956/957/958/959 Done；943/947为设计替代而Canceled。
- 详细责任、验证与剩余边界见 docs/planning/2026-09-06-business-architecture-closeout.md。
  原始 the-learning-project 脏main始终保留，所有改动在隔离工作树。

## NEXT

1. YUK-944：补齐typed合同并核对执行窗口后，完整actual仍待过；修复跨读取证据合成/过度断言后再验。
   未取得真实终文质量证据前不合并、不关闭944。SDK原生长会话压缩仍属945未完成。
2. YUK-946离线native SDK验证通过：首请求仅catalog，Skill调用后才出现body，真实模型费用$0。
   原eager-body前提已否证；不重建目录、不删除free-form quiz能力，不声称移除正文带来普通轮降本。
3. YUK-945同session compact/reinject→YUK-949成品选择→948显式Mission入口→950同轮steer。
   UI步骤另按设计预检；后端与纯测试可继续。不得用结束一个PR代替整个goal完成。
4. 全产品复核学习意图→录入→判分→掌握度/复习→提议/撤回的所有者和扩展成本；
   消除剩余有害写依赖与双规则，替换重复测试，按实际行为与扩展压力验收。
5. YUK-887生产副本backfill/audit/rebuild/golden与SoT退休需要独立授权；不阻断安全的实现工作。

## PARKED

- 944/945/946/948/949/950已列入NEXT的完整重构顺序，尚未完成，不再作为无限期PARKED。
- 951历史mailbox/ToolOperations仅drain-only恢复；退休需零pending/零队列活动跨完整重试窗口。
- YUK-921多provider、572夜间教研、832 HOLD未解锁。
- 保留计费、重试、prompt/skill、富结构解析、并发/回滚/恢复、UI加载安全测试；不按数量硬删。

## BLOCKED-ON

- 本轮没有未决UI设计门或CI阻塞；开放backlog不因本轮交付而虚假关闭。
- 生产clone验证、部署、SoT flag切换与历史数据删除均无授权，未执行。
