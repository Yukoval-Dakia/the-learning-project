# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-07：968实现与初审通过；首轮actual超时不接受，正在修验证prompt矛盾与CI失败。966已合并，整体goal active。

## NOW

- Active YUK968：root独占tlp-wt-unified-conversation / codex/yuk-968-closed-book-validation，base main5cf5dcca+交付记录9cf76668。
  计划①核对生成来源/验证轴与发布资格；②由现有领域owner收口契约并做真实复杂fixture回归；
  ③干净revision同样本actual，预留预算前不付费；④独立review与exactCI。只读设计lane协助，无并行writer。
  不伪造来源、不把未比较称原创；保持grounding/too_close/独立解题和教学质量保护。不改UI/生产。
  PR1349 draft，exactf3b6b3b4；初审无P0/P1。182unit/73workerDB/16ownerDB/12authorDB与本地gate通过。
  CI34061769583两项旧prompt hash失败已局部复现修复，保留实质政策断言；211unit/typecheck/build通过。
  真实一次生成/解题/教学通过，但内容验证终态缺失，90秒deadline失败。修basis shape/重叠rollup后同样本再验。
  已封存learning-content-deadline-actual.json；新增estimate0.0061130977，不能冒充账单或完整质量通过。
- YUK966 Done：PR1348 exactfefcf70e1a07b4ef554deb3d4c1b9eab4a1401fa，CI34059429533全部success；
  2026-09-06T21:05:27Z合并main5cf5dccab207c32b47b6ddb15163dff10c379080，未部署。
  既有drawer用同一DTO交付真实结果快照/恢复，不重查、不增加模型history token；复用领域schema与原验证owner。
  初审1P1已修，唯一验证947be81c PASS；实际发现数组null重生成/solver过程丢失，root RED→GREEN修复。
  182相关unit/28关联DB、既有108DB/20browser与全CI绿；删旧schema指纹但保留8项行为检查。
  read快照actual PASS但正文未请求recent_failures却说无，967待修；生成actual被安全拦截，968继续正向质量验收。
  review预算结束；无paid/测试服务进程。root独占tlp-wt-unified-conversation，当前codex/yuk-966-delivery-notes仅交付记录。
  业务owner只读复核：知识合并/录入完成/判分完成已有真实事务与失败恢复，不为9个必要owner造registry。
  SoT仍有部署兼容；仓库compose值不等于生产运行态，不擅删guard或翻flag。Notes分散写入需按不同业务操作判断，尚无重复规则证据。
- YUK965 Done：PR1347 exact6015f2a0fe1163eefc168ec782a5fb657099c0d7，CI34053995106全部success，
  已于2026-09-06T19:20:27Z squash合并main fbc87f3b1ade3bc726d9371033a4c073d6c6f1a3。
  已删除旧chat执行/mutex，保留conversation-writes；执行policy与history anchor收敛为持久生命周期。
  actual脚本走真实HTTP adapter/v2接纳/物理fetch/worker/终态wake，不声称自动poller。
  122unit/143DB、零付费cancel与HTTP admission-only、typecheck/lint/build/audits通过。
  PR1347初审88a4a603发现unified验收超时迟到成功P1；共用test deadline helper已修，2RED→4GREEN。
  修复后cancel/pickup零付费通过；唯一验证审6015f2a0 PASS，review预算结束；未部署。
  scoped输入测试由隔离lane提交并经root修订核验；无其它writer，不新增调度框架。
  一条真实read通过，clean exact88a4a603，estimatedUSD0.0006681774；新池reserve5.55823、安全剩4.44177。
  详情docs/planning/2026-09-07-retire-foreground-adapter.md。
- YUK948/950 Done：PR1346 exactcd1f7c54916c4d75dc1b64f29be2ec3fd1d363d9，CI34050991978全绿，
  独立初审与唯一验证PASS，review预算结束；已squash合并main9ebee3aebe4c2840120d577bdf08512dfc3596e6。
  /chat统一202/FIFO，per-run订阅/Stop，无缓存快照恢复；关闭/刷新/切会话不取消，延迟202不污染其它会话。
  SDK本进程owner与终文字节栅栏、教学原子提交、原6轮/25工具/累计读取量上限保留。
  108UI unit、27历史DB、82集成DB、20built-browser通过；自动poller零付费DB与两轮真实HTTP/native输出分别封存。
  首轮CI发现新queue suite泄漏等待轮；串行4≠3 RED后仅修teardown，9/9 GREEN，未改产品计数/旧断言。
  详见docs/planning/2026-09-07-unified-conversation-closeout.md；本轮UI/修复无新付费，未部署。
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
  新$10池合计estimated $0.0535364724；968第二轮另预留$0.90后总reserve$8.65823、安全剩$1.34177。
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
  撤回Mission按钮方案及其UI preflight；保留显式Stop与安全/预算限制。现有drawer批准改动已随PR1346交付。
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
- 965删除旧adapter session调用后依赖438/0/47，五capability SCC与20命令消费者仍在；
  新增持久化所需合法调用不是重复状态实现，不用包装转发隐藏它以压数字。
  learning-intent已有单事务/失败全回滚，不为减少SCC计数再次重构。

## NEXT

1. 968闭卷生成与来源/原创性验证语义收口，967未请求recent_failures不能当零；同实际样本验收，不降低保护。
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

- 966/965已交付，review预算结束，不重开；968/967暂无owner决策阻塞。
- 未授权部署、生产clone、SoT开关、backfill或历史数据删除；均未执行。
- 原始the-learning-project脏main始终不动；实施使用独立工作树。
