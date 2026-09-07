# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-07：887 Mac本地切换已验证；973接续双轨代码退休，NAS不在范围，整体goal active。

## NOW

- Active973：root独占tlp-wt-unified-conversation / codex/yuk-973-retire-state-writers。
  前置PR1355已合并main960731083，exact6d476fc9 CI34112766637全绿；review初审+唯一验证完成，无第三轮。
  原子迁移补锚/值与rowset audit/显式DB目标保护通过51DB+1真实bundle unit，副本实跑通过；未新部署。
  后续10生产文件已删主要双轨分支（尚未交付）；38初步DB过，扩大106例9个legacy fixture失败已迁移前置修复。
  再补未准备数据禁止付费/丢弃事务回滚，最终108 scoped DB和typecheck通过；flags、重复OFF/ON测试、LI merge单writer尚待收口。
  merge归属当前在accept rate之前imperative更新，历史repair共享路径；architect只读核对中，不盲目替换成早投影。
  最终仍需完整scoped/gates/独立新lane review/exactCI；973保持In Progress，不将前置PR当整体完成。
- 887 local-production切片已部署：PR1354 exact0ed35fd3，CI34108722202全绿，main a12667507，独立安全review PASS。
  owner「直接动本地生产即可」仅授权Mac，不含NAS；API/worker/Postgres均healthy，未启动tunnel。
  target=the-learning-project-postgres-1 / the-learning-project_pgdata / 127.0.0.1:5433/loom。
  31MB，12knowledge/7learning_item/8artifact/391event，migration94条；1failed memory ingest及1createdDLQ不自动重烧。
  dump已真实恢复至隔离DB，7个B3 cluster全部GO、8golden birth清洁；77学习闭环DB+36迁移护栏DB通过。
  live迁移94→101，builtin traits升级8；回填9KC+22calibration genesis，重复0新增，live audit无drift，outbox仍0。
  实体数量12/7/8不变，event391→422；item_calibration保持OFF，未live rebuild，无新增paid。
  tracked Mac override补goal/variant/LI三个flag，两角色一致；镜像clean55aaac30，API loopback8787/RW_WORKER0。
  启动后hydrated audit零drift；浏览器认证/抽屉/刷新恢复/settled summary通过，未发送模型消息。
  ai_task_runs258/provider_attempt4未增；所谓7个历史恢复经精确谓词核实为0，额外$3授权未使用。
  887被GitHub自动Done后已恢复In Progress，完整provider/crash矩阵尚缺。
  详见docs/planning/2026-09-07-local-production-state-cutover.md；NAS不在范围。
- YUK971 Done：PR1353 exactcffec1b5，CI34106719123 docs-only成功，独立初审PASS；main55aaac30，未部署。
  仅修正三份Ingestion/Copilot AGENTS：自动VLM baseline、额外rescue授权、Notes artifact owner与FULL呈现控制。
  纠正导航链接并删除易过时的模型/路由数量缓存；不改产品代码、prompt、provider或生产。
  6个本地链接、7项文档unit及本机typecheck/lint/build通过。
- YUK970 Done：PR1352 exact46a237c49859d8c8c17c2a81c1aeb8a7da7126ba，CI34066586538全绿，
  2026-09-06T23:24:57Z squash main07280e6b30a63ed06f927bc2f20d38615996447e，Linear Done，未部署。
  退休Agency/Ingestion整体schema迁移指纹、指纹自测及Agency/Copilot重复旧路径断言；明确effect/cost/mirror断言。
  保留真实loader、全部权限、公共reader、central registry、legacy drain及rich DB行为检查；15unit/103DB通过。
  architecture/capability audits与typecheck/lint/build通过；独立初审PASS无finding，无产品修改/paid。
  录入完成/判分落库/知识合并只读复核已有owner与事务回滚；判分同步/队列不等于Copilot产品生命周期分裂。
- YUK762 Done：PR1351 exact36da8192347383de1d0f4d73c2f011f5ad56fa15，CI34065494164首轮全绿，
  2026-09-06T23:04:09Z squash main15eceba0dfebe5b4b06ac3cf3e52f69be12df597，Linear Done，未部署。
  原归因case14460ms中14390ms耗在深比较Drizzle连接对象；改直接连接身份断言后同case34ms。
  23项全文件DB通过（1.47s测试体）；原业务/权限/幂等/失败断言与60s门槛保留，无产品代码变化。
  初审无P0/P1，typecheck/lint/build通过；不是把旧CI重跑绿当根因修复。
  全ADR漂移审计未完成，不作全量结论。
- YUK967/969 Done：PR1350 exacta290eafed56c283e088a7e8f0a8e3646e81cba44，CI34064877513 attempt2全绿；
  2026-09-06T22:54:49Z squash合并main5cac4753cd2e8235562eddab2ece3d6618d3e56d，Linear均Done，未部署。
  967知识读取owner明确not_requested/no_returned_nodes/observed及限定absence资格；stats30d与failure历史latest10分开。
  12readerDB+34snapshot/fixtureDB/typecheck/lint/build与独立初审PASS。
  clean5717bcbd原presentation-tool actual通过，one root/read/presentation，无凭空失败记录断言；
  live/persisted同1502B snapshot，input41516较旧41280多236，不声称降token或费用。证据knowledge-observation-actual.json。
  969题池pass+copyunknown已真实DB RED→GREEN，不晋级/不FSRS/不继续paid validators，rawunknown保留；
  37DB/typecheck/lint/build与独立初审PASS，未改learner-visible特殊政策或旧solver保守政策。
  两lane均完成初审，无P0/P1。root集成100DB/41unit/typecheck/lint/build及架构gate通过，PR1350。
  首轮CI34064358949仅旧knowledge整体schema哈希失败；退休迁移指纹与自测，保留加载/权限/成本/mirror政策。
  3unit/typecheck/lint/build通过；新CI原归因60s超时再现，精确两例本机通过后仅重跑失败lane，762独立根因修复接续。
  实际检索发现AI AGENTS旧tools/judges路径已不存在，导航改指kernel allowlist与capability manifest/Practice judge。
  无paid进程；新池estimate0.0721137375非账单/reserve9.95823/safe0.04177；原脏main与生产不动。
- YUK968 Done：PR1349 exact0e9bade2fb8bfd14d1e17ceb812ad7e0ea01ecae，CI34063583368全job success。
  2026-09-06T22:29:03Z squash合并main5bd921e3feed2a0de1490ba3ee49b37488420b37，未部署。
  Practice共同内容验证/真实工具来源绑定与重复author parser退休；原90s/权限/预算不放宽。
  clean219a1816正向actual：one author/one presentation，7×12=84和分配律正确，全validator/live/persisted一致。
  deadline、重复control与positive三份证据完整保留，原raw digest复核全部匹配。
  CI首轮旧prompt指纹已按实质政策替代；后续backlog6≠3已注入旧ledger RED→GREEN，
  再修timestamp323误判泄漏，57串行DB+3targeted/typecheck/lint过，未改产品实际输出代码。
  初审+唯一验证PASS，review预算结束，不再启动第三轮。全局goal仍active。
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
  新$10池合计estimated $0.0721137375；967读取后总reserve$9.95823、安全剩$0.04177，不回收reserve。
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

1. 973收口Goal/LI/variant双轨写入：迁移补锚并验证，业务单路径，保留撤回/并发/派生列保护。
2. 复核成本展示的reported/estimated/unknown边界，不把公开USD估算说成真实CNY合同或账户扣费。
3. 全产品复核学习意图→录入→判分→掌握度/复习→提议/撤回的所有者与扩展成本。
   946已按原生Skill catalog→调用后body验证Done，不重建第二目录、不删quiz。
4. 887本地backfill/audit/rebuild/golden与SoT退休按新授权推进，NAS仍不在范围。

## PARKED

- 972自定义学科unit_dimension仍被physics名称限制，已代码核验/LinearTodo，887本地frontier后修复。
- 全历史ADR审计仍未完成，不冒充全量通过；971仅覆盖三份已确认冲突的现役指引。
- 951旧mailbox/ToolOperations仅drain-only；退休需零pending/零队列活动覆盖完整重试窗。
- 921多provider、572夜间教研、832HOLD不解锁。
- 计费、重试、prompt/skill、复杂parser、并发/回滚/恢复、UI安全测试仍保留，不按数量硬删。

## BLOCKED-ON

- Mac本地生产已授权直接操作；NAS部署/数据操作仍未授权，不执行。
- 不主动重跑现存failed memory/DLQ或新增超预算模型验收；历史费用unknown保留。
- 原始the-learning-project脏main始终不动；实施使用独立工作树。
