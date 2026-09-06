# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-07：948/950界面已获批准；真实HTTP/native连续会话验收通过，继续UI集成与浏览器验收。

## NOW

- Active线948/950，root独占工作树tlp-wt-unified-conversation；SDK与FIFO独立lane已合入并释放。
  ADR0062锁定一个会话生命周期，服务端顺序接纳/唯一执行；并行lane不共享写工作树。
  当前任务计划：①唯一SDK owner parity；②持久接纳/FIFO与故障恢复；③教学原子路径迁入；
  ④统一API、服务端快照与已预检UI；⑤scoped/真实断线与模型验收、独立review、exact CI。
  UI四文件预检已获owner批准，独立conversation-dock lane实施；后端入口已统一，完整体验尚待集成验收。
  root已集成SDK lane并修掉初稿的早登记、DB未写、context digest未投递、重复拼保存说明等缺口；
  真实writer返回字节决定是否保留cursor，本进程绑定+256上限，失败/改写/Stop冷启，不同轮不重烧。
  teaching已走同一worker栅栏与终态marker：三种教学状态live/repair/replay，题目和回复原子提交；
  ask_check禁止错误revert anchor，Stop后不materialize。当前85集成DB与typecheck通过。
  Queue lane最终5fcae986经7c92403cf合入；terminal/Stop在提交后唤醒后继，失败由现有reconciler恢复。
  /chat普通/chip/teaching统一202，必须稳定幂等key；durable旧字段不再选择生命周期，禁用queue不回退inline。
  head任务与接纳同事务；后续轮持久等待，不409 busy；默认仍6轮/25工具，12分钟安全墙钟。
  server snapshot已含session/turns/active_runs；公开tool/subtask进度顺序持久化，不泄漏Task prompt。
  chip使用共享输入writer但保留system事件身份，不暴露typed-ask撤回锚；Stop同样识别chip。
  已删除旧HTTP SSE执行分支及其专属测试，保留幂等/歧义/取消/校验/回滚测试；没有按数量硬删。
  最新126unit、89worker/FIFO/history DB、typecheck/Biome/build通过；948/950 Linear均In Progress。
  后续真实route→PG接纳/丢响应/无缓存恢复/追加/等待Stop/worker后继/因果历史场景通过；queue现8项。
  发现durable默认跳过累计读取量预算，已删除分支复用capInput；合法60节点请求第17次仅余40，RED→GREEN。
  保留6轮/25工具和原row上限；105相关unit、64集成DB及typecheck/Biome/build通过，无新增付费。
  UI lane旧worker f6cd585/751361390仅初稿，per-run Stop/恢复仍不完整；architect接手完成，不直接合入。
  a5bfa5a3真实HTTP/pg-boss/worker两轮actual通过；SSE断开后完成，SDK同id cold→resume，精确保留0/null/方向/未批准。
  公开卡estimated $0.0007353978、保守reserve $1.6；实际输入13203→13370不声称token下降。
  此证据不覆盖自动poller/浏览器/自动compact；manifest后继装配的真实DB和0付费admission-only另验。
  boss唤醒装配归manifest，不让worker创建runtime；原生session持久化新增1条合法owner依赖，baseline439/0/47。
  9f61ba1d增加服务端同会话ask/chip run_id，与checkpoint撤回资格独立；27历史DB/类型检查通过。
  UI最终6895c4f5经b92177f86合入；per-run Map/订阅/Stop与延迟202跨会话保护完成，108 UI unit通过。
  root修正自动合并带来的重复run_id类型声明；7个built-browser Copilot场景通过，未调用模型。
  全部既有shipped-browser smoke20/20；typecheck/lint/build与API/架构/control-plane检查通过，准备PR独立review。
  自动pg-boss poller另验：真实registrar/manifest消费已完成head并推进已Stop后继，两physical job完成、model零调用；queue8/8绿。
  仍待UI集成与浏览器验收、独立review与exact-head CI；上述真实模型验收已通过但不替代这些门。
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
  新$10池合计estimated $0.0352456927，保守预留$5.30823、剩$4.69177；当前停付费。
- YUK949：owner明确选FULL，允许按需短presentation control交互，ADR0061；
  agent看完结果提名，server校验，保留tool_result/artifact/ephemeral_html；不提高预算、不改生产UI。
  初稿ea8367c7的5P1已由81eb7f3e修复，ed693e16集成main9e02c48b。
  唯一验证审确认原5项已修；新发现raw artifact类型无导航，root改为owner-resolved canonical ref。
  208集成unit+76针对性unit/49durableDB/6引用DB通过；唯一验证审PASS，无第三轮。
  8个shipped浏览器用例验证三类hero/无hero的inline+durable+刷新恢复，无生产UI改动。
  actual过程无hero/read引用/author→artifact通过；三次HTML模型保存误述完整保留，不冒充模型遵循。
  081471e4将真实保存说明交给shared commit owner，保留实质正文并明确权威状态；同步reseal/hash及SDK cursor。
  三条真实失败终文免费重放全部通过；322scoped unit、56DB、typecheck/lint/build通过。
  PR1345最终exact630571bc7cf53689780e4a501f8dc2283d153508 CI34043412808全绿，已squash合并main4d475ac2。
  960后续同一行题目/礼貌请求P1均RED后修复，最终62scoped tests/typecheck/lint/build绿。
  949/960 Linear Done；旧cc3afecd DB2超时不计通过。未增付费/第三轮review，tool_result仍为既有placeholder。
  非阻塞P2随948收口：root已修commit receipt丢view仍retained；artifact引用复用Notes-owned ready资格，16相关DB绿。
- YUK948/950 owner新决定：Copilot不分前后台，默认不中断；关闭面板/刷新/断线只脱离订阅。
  服务端唯一执行owner；同一会话后续消息持久接纳并顺序消费，不409 busy、不要求先Stop。
  撤回Mission按钮方案及其UI preflight；保留显式Stop与安全/预算限制。现有drawer四文件改动已获批准并在独立lane实施。
  复用copilot_run并补teaching、native compaction、无本地缓存恢复的parity，不新增第二调度框架。
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
- 主线依赖438/0/47，集成线因原生session owner调用为439/0/47，五capability SCC与20命令消费者仍在；
  新增持久化所需合法调用不是重复状态实现，不用包装转发隐藏它以压数字。
  learning-intent已有单事务/失败全回滚，不为减少SCC计数再次重构。

## NEXT

1. YUK948统一持续执行与服务端恢复；950同会话追加消息，禁止以先Stop/409拒绝替代。
   后端/UI已集成且7个Copilot浏览器场景通过，继续全页面smoke、独立review与exact CI。
   后继YUK965退休仅验收使用的runCopilotChat旧适配器；迁移有效actual场景后删死路径，不删除失败/恢复保护。
2. 复核成本展示的reported/estimated/unknown边界，不把公开USD估算说成真实CNY合同或账户扣费。
3. 全产品复核学习意图→录入→判分→掌握度/复习→提议/撤回的所有者与扩展成本。
   946已按原生Skill catalog→调用后body验证Done，不重建第二目录、不删quiz。
4. 887生产副本backfill/audit/rebuild/golden与SoT退休仍需独立授权。

## PARKED

- 951旧mailbox/ToolOperations仅drain-only；退休需零pending/零队列活动覆盖完整重试窗。
- 762归因DB测试60s超时复发，需查等待与连接生命周期；当前因果未证，不把资源压力当结论。
- 921多provider、572夜间教研、832HOLD不解锁。
- 计费、重试、prompt/skill、复杂parser、并发/回滚/恢复、UI安全测试仍保留，不按数量硬删。

## BLOCKED-ON

- 当前948/950已获UI批准，实施与验收进行中，不标完整goal blocked或complete。
- 未授权部署、生产clone、SoT开关、backfill或历史数据删除；均未执行。
- 原始the-learning-project脏main始终不动；实施使用独立工作树。
