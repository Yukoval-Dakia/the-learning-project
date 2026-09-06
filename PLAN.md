# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-06：945/964已合并；949完整展示控制集成及真实验收，960有界修复。

## NOW

- Owner授权AI pipeline和全项目业务封装/测试精简；完整goal仍active，不以audit数量或单个PR代替完成。
- YUK945：foreground原生SDK compaction、每轮learner状态、compact后结构化再注入；
  原6轮/费用/row/tool/deadline不重置，usage仅存bounded compact元数据。
  初审两P1已修，143 scoped tests及唯一复审通过；不再启动第三轮review。
  两项真实MiMo样本通过同session事实保留与更新learner；旧fixture未重新发送。
  短会话1057→1388变长；120条过期记录样本11977→1590（上下文约减86.7%）。
  这是manual native compact质量/大小证据，不是自动阈值、净费用节省或生产/queue E2E。
  PR1339 exact60429d44 CI34035583914全绿，已合并main8e534d3c，Linear Done。
  最终集成148 scoped tests/typecheck/lint/build通过；未部署。
- Owner新增$10验收预算；945两样本共10个真实请求，公开USD卡估算$0.0130696878。
  保守请求预留合计$0.90823；此前余额$0.28771982单列，历史未知费用不填0。
  公开费率估算不冒充账户账单，SDK派生USD保留为独立观察。
  949另跑7个受控回合（含失败）：estimated $0.0214406071，case预留$2.8。
  新$10池合计estimated $0.0345102949，保守预留$3.70823、剩$6.29177；当前停付费。
- YUK949：owner明确选FULL，允许按需短presentation control交互，ADR0061；
  agent看完结果提名，server校验，保留tool_result/artifact/ephemeral_html；不提高预算、不改生产UI。
  初稿ea8367c7的5P1已由81eb7f3e修复，ed693e16集成main9e02c48b。
  唯一验证审确认原5项已修；新发现raw artifact类型无导航，root改为owner-resolved canonical ref。
  208集成unit+76针对性unit/49durableDB/6引用DB通过；唯一验证审PASS，无第三轮。
  8个shipped浏览器用例验证三类hero/无hero的inline+durable+刷新恢复，无生产UI改动。
  actual过程无hero/read引用/author→artifact通过；一次性HTML控制+保存成功，但连续3次保存误述，
  已完整保留语义失败，不能把script绿色当质量通过。prompt及typed lifecycle事实仍未足够约束模型。
  root当前59156663；只读咨询最小业务收口方案中。tool_result仍是既有named placeholder，未新增数据卡。
- YUK961 Done：Agency拥有pool-gap提示政策，Practice仅提交verify事实；
  PR1340 exact69542b2d CI34032977403绿，main50ba305b；48DB/独立review通过。
- YUK962 Done：5个纯测试文件移入unit，59tests通过，总1043文件不减；
  617unit/426DB，无DB重复收集，保留传递DB与Bun测试。PR1341 exacta522a60f
  CI34034085071绿，mainc43d51be；独立review/typecheck/lint/build通过。
- YUK963 Done：record命令审计缺口红绿复现，70tests通过；不增豁免。
  PR1342 exact417623b5 CI34034266076绿，main4034859c。
- YUK964 Done：复用catalog公开分模型USD卡，不再把正数MiMo SDK派生金额当reported账单。
  4项RED后37unit/24runnerDB通过，10条已封存真实wire免费回放全部匹配，review PASS。
  CI暴露4条旧失败路径成本断言，保留失败/恢复/usage断言并更新estimate；AI目录418unit全绿。
  typecheck/lint/build/audit通过；PR1343 exactc1afae75 CI34036794558绿，已合并main9e02c48b。
  无新增付费、不改历史ledger、未部署。
- YUK944 Done：PR1338 exact3fd90c4d CI34030191329绿，main db5a57b1。
  五读取actual核心通过，但input40410 vs40401持平，不能称该复杂样本降本。
- 已交付：Pipeline1326、Goal1327、Knowledge1328、Import1329、execution1330、
  ReviewSettlement1332、测试1331/1333、客户端/后端状态1334/1336，各自review/exact CI绿。
  954 hidden child终态及958权威REPLY恢复已修；客户端116unit+15browser流程验证。
- 主线依赖438/0/47，五capability SCC与20命令消费者仍在；正常owner命令合作不等于重复规则。
  learning-intent已有单事务/失败全回滚，不为减少SCC计数再次重构。

## NEXT

1. YUK949完整呈现actual与exact CI交付，后台/前台/恢复共享发布语义。
2. YUK960 exact960d0b64，29unit/typecheck/lint/build及唯一复审PASS，PR1344。
   CI34038363273原unit/static/build绿；旧attribution DB测试60s超时后连接错误，scoped两例本地绿，
   同exact失败lane已重跑。原762去重重开Todo，不加timeout、不删保护；960尚未合并。
3. YUK948显式Mission入口、950同轮steer、960报告问句误拦；保留真实学习内容保护。
4. 复核成本展示的reported/estimated/unknown边界，不把公开USD估算说成真实CNY合同或账户扣费。
5. 全产品复核学习意图→录入→判分→掌握度/复习→提议/撤回的所有者与扩展成本。
   946已按原生Skill catalog→调用后body验证Done，不重建第二目录、不删quiz。
6. 887生产副本backfill/audit/rebuild/golden与SoT退休仍需独立授权。

## PARKED

- 951旧mailbox/ToolOperations仅drain-only；退休需零pending/零队列活动覆盖完整重试窗。
- 762归因DB测试60s超时复发，需查等待与连接生命周期；当前因果未证，不把资源压力当结论。
- 921多provider、572夜间教研、832HOLD不解锁。
- 计费、重试、prompt/skill、复杂parser、并发/回滚/恢复、UI安全测试仍保留，不按数量硬删。

## BLOCKED-ON

- 当前949/960有安全实施路径，不标完整goal blocked或complete。
- 未授权部署、生产clone、SoT开关、backfill或历史数据删除；均未执行。
- 原始the-learning-project脏main始终不动；实施使用独立工作树。
