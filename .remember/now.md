# 当前 handoff — 2026-09-07，完整重构goal active

## 最新状态

- Active YUK968，root独占tlp-wt-unified-conversation / codex/yuk-968-closed-book-validation。
  Practice联合验证owner+真实工具input/output来源绑定；Copilot只匹配可见内容，复用kernel已有DTO。
  额外grounding.basis仅learner-visible purpose必需；旧题池/intervention兼容。copy unknown不伪称原创，限定预览并明示未比较。
  strict solve须明确等价，partial/unsupported/低置信不再当可见成功；旧保守题池政策不变。重复作者parser已退休。
  182unit/73worker-snapshotDB/16ownerDB/12作者DB、typecheck/build/lint/架构通过；独立初审无P0/P1。
  PR1349 draft exactf3b6b3b4，CI34061769583 unit失败待修。首轮actual一次生成、解题和教学通过，90秒超时未通过。
  QuizVerify终态缺失，不凭usage认定完成。证据learning-content-deadline-actual.json；当前无paid进程。
  新池estimate0.0535364724/reserve7.75823/safe2.24177，不回收reserve。正在对齐prompt basis输出及互斥rollup。
  上述prompt/旧hash失败已修，211unit/typecheck/build通过；第二轮同样本预留0.90，新reserve8.65823/safe1.34177。
  第二轮ae7c7a3c内容正向通过：one author，7×102=714，全validator通过，live/persisted一致；2次相同展示提名使全case失败。
  封存learning-content-presentation-repeat-actual.json；新增estimate0.0067764702，累计0.0603129426。
  明确工具成功后收尾不重复同一提名；第三轮另reserve0.90后总9.55823/safe0.44177。唯一验证审PASS，review预算结束。
  52题池/ownerDB通过。旧题池矛盾rollup疑点去重YUK969 Todo，不伪称生产漏洞或已复现。
  设计docs/planning/2026-09-07-learning-content-validation.md。原脏main与生产不动，整体goal active。

- YUK966 Done：PR1348 exactfefcf70e1a07b4ef554deb3d4c1b9eab4a1401fa，CI34059429533全部success；
  2026-09-06T21:05:27Z合并main5cf5dccab207c32b47b6ddb15163dff10c379080。
  root独占tlp-wt-unified-conversation，当前codex/yuk-966-delivery-notes仅交付记录；下一条968，之后967。
  Owner批准现有drawer发送/恢复/消息展示；已补真实工具结果快照，model仅提名ref，server校验并独立捕获。
  初稿通用字段过滤不合格已由root替换：复用真实registered outputSchema，逐工具公开policy，opaque/私有字段剥离。
  单一DTO贯穿live/worker修复/history/client；真实空值与缺失区分，刷新不重查，不增加模型history token。
  78unit/108DB/20built-browser已绿；初审1P1生成JSON绕过内容校验已修，唯一复核947be81c PASS，review预算结束。
  PR1348 f439a0be首轮CI只旧迁移schema指纹断言失败；去掉过期hash，保留8项真实权限/组合行为检查。
  真实read卡片交付PASS；终文未查询recent_failures却声称无，原始输出完整保留，去重创建967，不称整体语义绿。
  文档docs/planning/2026-09-07-copilot-result-snapshots.md；新增registry读取边baseline439/0/47，无新SCC/writer豁免。
  候选题actual947be81c未通过（正确拦截），7tasks estimate0.0075136679；原始证据已封存question-snapshot-actual.json。
  实际发现optional数组null重生成/solve-check未传已有解题过程，root均RED→GREEN修复，182unit/typecheck/build通过。
  正向生成卡仍待968闭卷来源/原创性验证语义收口；未降低copy_safety/grounding门槛。967读取未观测≠零也开放。
  新池累计estimate0.0474233747/reserve6.85823/safe3.14177；当前无paid进程，不回收保守reserve。
  原脏main不动。临时built server94648已TERM并确认退出，无paid/测试服务进程；未部署，整体goal active。
  最终28关联DB（author_question+snapshot）也通过；同一生成器原题库流程未降级。

- PR1347已合并：exact6015f2a0fe1163eefc168ec782a5fb657099c0d7，CI34053995106所有job成功；
  main fbc87f3b1ade3bc726d9371033a4c073d6c6f1a3，mergedAt2026-09-06T19:20:27Z，Linear965 Done。
  初审1P1已修，唯一验证审PASS，预算结束不第三轮；126unit/143DB、actual read和零付费队列验收留存。
  root已从origin/main建codex/yuk-965-delivery-notes，仅提交看板/交付记录；原脏main未触碰。
  下一条全产品扩展成本最终复核：先现有业务owner/测试census，不按数量重构，真实缺口再Linear查重捕获。
  当前无运行付费/服务进程，无其它writer；新池safe4.44177/reserve5.55823/estimate0.0359138701。
  887/856仍待独立生产授权，951旧恢复器需部署后drain证明，859无具体consumer不纳入实施收口。

## 965交付前实施记录（以下状态已由最新状态取代）

- 965实施已在root独占树完成：旧chat/mutex退休，shared conversation-writes保留；唯一执行policy与必需history anchor。
  actual harness迁生产HTTP adapter/v2事务接纳/物理fetch/runCopilotRun/终态wake，旧v1草稿未合入。
  143 scoped DB、取消及统一HTTP admission-only零付费通过；typecheck/lint/build/audits已绿。
  122unit与143DB通过；PR1347初审88a4a603发现unified超时可接纳迟到成功P1，修复共用deadline helper。
  旧逻辑2RED含unhandled Stop rejection；修复4GREEN，真实cancel/pickup零付费再验绿；随后唯一验证审/CI均通过。
  965 read actual在clean88a4a603通过，estimate0.0006681774；新池reserve5.55823、安全剩4.44177、累计estimate0.0359138701。
  已封存docs/planning/evidence/2026-09-07-retired-adapter-read-actual.json；无正在运行付费进程、未merge/deploy。
  下方“仅计划”是之前handoff，已由本条取代。

- PR1346已合并：exact cd1f7c54916c4d75dc1b64f29be2ec3fd1d363d9，CI34050991978全部success，
  main9ebee3aebe4c2840120d577bdf08512dfc3596e6，mergedAt2026-09-06T18:24:16Z。
  初审70189a91 PASS，test-only修复唯一复核cd1f7c54 PASS；review预算结束，无第三轮。
  首轮CI34050192068的queue→backlog泄漏已串行RED→GREEN修复；108UI/27历史DB/82集成DB/20browser绿。
  所有UI/SDK/FIFO writer已释放，无运行paid/server/watch进程，未部署，原始脏main不动。
- 当前root仍独占tlp-wt-unified-conversation，已切新branch codex/yuk-965-retire-foreground-adapter，base origin/main9ebee3ae。
  本分支当前只提交交付记录/任务计划，尚未实施965代码：先盘点旧adapter验收消费者，再迁到persistent owner，
  退休旧foreground lifecycle与专属测试，保留shared writer/教学/claim/取消/预算/SDK保护。
  YUK948/950 Done；YUK965接续In Progress；整体goal仍active。
  $10池安全剩4.69177，estimate0.0352456927非账单/reserve5.30823；旧池0.28771982单列，无新付费。

## 历史实施过程（不替代以上最新状态）

- PR1346已push exact70189a91，独立初审review_unified_conversation PASS，无P0/P1。
  CI34050192068仅DB2失败，durable-backlog计数4≠3；root用queue+backlog两文件单fork稳定复现。
  原因是新queue suite最后的等待轮job_events未清理；resetDb仅domain tables，不包含operational ledger。
  root已补该suite afterEach清理physical jobs+job_events；同一串行9/9 GREEN，旧断言/产品逻辑不动，未新增付费。
  本地build服务已停止；PR未merge/deploy。整个goal active，965后继尚Todo。

- Owner已明确批准现有Copilot抽屉发送/恢复/消息展示四文件改动，UI不再blocked。
  独立tlp-wt-conversation-dock branch codex/yuk-948-conversation-dock；worker初稿f6cd585/751361390不完整，
  已释放并由architect complete_unified_dock_ownership独占继续，当前在做Map<runId>订阅/Stop/snapshot恢复。
  root独占tlp-wt-unified-conversation，a5bfa5a3实际验收harness+文档、1f705b5e装配/证据/账本均已commit。
  最新9f61ba1d增加AI replay run_id（同session ask/chip才有），不改变checkpoint撤回资格；27DB/类型检查绿。
  UI最终6895c4f5经b92177f86合入root；已释放writer，108 UI unit通过。自动合并的重复run_id字段root已修。
  root的7个built-browser Copilot场景通过（连续发送/独立Stop/无缓存恢复/原key歧义恢复/四类展示/模式结束）。
  48117a8f用真实registrar/manifest自动poller消费已终态head并推进已Stop后继，queue8/8、模型零调用；另82相关DB通过。
  新增YUK965 Todo记录仅验收还消费旧runCopilotChat适配器的结构残留，待948/950交付后接续，不冒充整个goal完成。
  真实actual2轮通过：.tmp/actual-provider-acceptance/1788714763712-2c71c672-f7a1-4345-9264-1349f295d1e5.json，
  已封存docs/planning/evidence/2026-09-07-unified-conversation-actual.json；exacta5bfa5a3，dirty仅当时PLAN更新，
  real HTTP+pg-boss fetch+production handler（不是自动poller）：两轮订阅均断开仍done，native SDK同6ed0df57-04c2-485d-8042-aaa9a9ba2d10。
  promptCodecMode cold→resume，第二轮精确复述0/null/有向关系/unobserved/未批准，并加入UPDATED-92。
  input13203→13370、output60→415，不声称token减少；两root均无tool/child，原始思考仅计数，不持久化。
  本次estimatedUSD0.0007353978（非账单），reservedUSD1.6；新$10总estimateUSD0.0352456927，
  reserveUSD5.30823、安全余USD4.69177；旧池USD0.28771982单列。无正在运行付费调用。
  架构audit发现新增boss/session边，root把后继runtime装配归manifest，worker只接wake回调；
  session持久化的1条owner调用合法保留并更新baseline439/0/47，不用shallow wrapper藏计数，未改SCC/豁免。
  64worker/FIFO DB通过；实际manifest loader接线纳入queue用例，admission-only预检另跑0调用。
  最终UI集成/20浏览器/独立初审已过；PR1346已push，首轮CI需上述test-only修复，未merge/deploy，整个goalactive。

- 后续goal continuation：上一轮9f8798ef属实质progress，本轮UI批准仍未收到；继续独立后端工作。
  新增真实/chat→queue→/turns→Stop→worker-terminal-wake→history综合场景，仅mock测试enqueue开关，
  验证丢202 body后无本地handle恢复、追加3轮、Stop等待轮不误停当前、后继保留context、读到晚到前轮reply。
  queue8项与worker56项共64DB通过，不冒充真实HTTP socket断线或模型实际输出。
  发现统一durable仍绕过capInput累计读取量限制；共享owner删除该例外，6/25与原1000node/4000event上限不变。
  使用真实schema允许的60节点/次，前16次960、第17次仅40、第18次softstop；恢复旧分支RED，再修复GREEN。
  105相关unit/typecheck/Biome/build通过。初始explorer误读旧worktree结果被拒，复查精确9f8798ef后才采纳。
  该只读bounded核对不是948最终独立PR review；review预算仍未启动。没有新增paid/UI/deploy。

- 2026-09-07后续集成：7c92403cf合入queue最终5fcae986；当前root无其它writer。
  /chat全部消息统一202持久接纳，必需稳定Idempotency-Key；旧durable值不控制执行路径；queue禁用显式503。
  terminal/Stop在事务提交后唤醒后继，失败由reconciler接管。chip输入共享writeCopilotInputEvent，
  保留system/chip action，不伪装typed ask；取消与终态同样不暴露chip撤回锚。
  worker持久化安全tool/subtask STEP，串行drain先于terminal；Task内部prompt/result不公开。
  原api/tool-use-sse及其4项保护测试已迁server/tool-activity，由worker实际消费，不留仅被测试调用的死代码。
  最终126 scoped unit、89 worker/FIFO/history DB、typecheck、Biome与build通过；另8取消DB、17教学/API/skill DB已绿。
  server/turns已有按根事件顺序纳入晚到前轮reply的规则，不另写第三历史reader。
  新增worker活动测试最初复用了旧runID而读到旧job_events，已改独立ID；旧workerfixture补真实input root，
  防止无root导致materializing/checkpoint测试假绿。未削弱原失败/恢复断言。
  UI四文件预检仍待批准；未写UI、未新增paid、未push/PR/merge/deploy。948/950 Linear均In Progress。
  最终review与真实统一会话验收尚缺；整个goal保持active。

- 949/960已交付：PR1345 exact630571bc7cf53689780e4a501f8dc2283d153508，CI34043412808全绿，
  已squash合并main4d475ac2b95004dc4c166e84a49ba575de7a82c9（2026-09-06 16:00:56Z）。
  62内容校验/finalization tests覆盖同一行题目答案及礼貌请求，实际报告与修辞问句仍不误拦。
  两个P2已defer到948：receipt最终视图状态、artifact ready eligibility；无第三轮独立review。
- 当前root独占 /Volumes/YukovalSBak/yukoval-projects/tlp-wt-unified-conversation，branch codex/yuk-948-unified-conversation。
  ADR0062 f5a9c3cb锁定统一持续会话；4bf68959教学原子commit+cancel传播；236e5999集成SDK lane。
  root修复该lane早登记/未持久DB/digest未投递/重复拼notice/earlycancel清理，不能信任原worker初稿完成声明。
  最终字节必须来自sharedwriter实际return，candidate一致才保存cursor；本进程conversation→SDK绑定有256上限。
  teaching已走worker同一paid fence/outcome marker、真实taskid/Stop/原子question+reply；三kind共享live/repair/replay。
  root还修复失败去view后receipt retained字段；artifact ready资格已复用Notes owner并经16相关DB验证。
  85集成DB（55worker+4teaching lifecycle+26turns）、123unit、typecheck/lint/build通过。
  测试仅mock外部模型，writer/marker/DB实际运行；未声称实际模型/浏览器统一会话已通过。
- Queue工作树tlp-wt-session-queue，branch codex/yuk-948-session-queue，最终5fcae986已合入root并释放。
  原worker f571a469/7e9af683不完整不可直接交付；architect最终22DB/61unit及本地gates/audits通过。
  root已接terminal wake、默认统一入口、6轮/25工具预算及服务端active_runs快照。
  SDK tree tlp-wt-worker-session latest测试f5dee551，已合入root；原worker与tester都已释放，无其它writer。
- UI预检仍待批准：现有drawer的CopilotDock.tsx/message-projection.ts/subtask-events.ts/durable-reconnect-storage.ts。
  不新增Mission/后台按钮，不改视觉，不把session_busy或先Stop作为追加消息实现；UI代码未写。
- 新$10池：estimatedUSD0.0345102949（非账单）、reservedUSD3.70823、安全剩USD6.29177；旧池USD0.28771982独立。
  本轮没有任何新的付费调用。原始脏main不动，未部署/clone/改SoT/删历史。

## 历史步骤（保留证据，不是当前待办）

## 当前949收口；下一条948/950统一持续会话
- Owner最新决定：Copilot消息不分前后台，默认不中断，对标ChatGPT；旧Mission按钮提案撤回。
  后端复用copilot_run唯一owner，HTTP断线仅取消订阅；关闭/刷新可从服务端恢复，不依赖sessionStorage。
  后续消息必须持久接纳同一会话并顺序消费；不接受session_busy409或“先Stop再发”降级。
  显式Stop、安全/预算限制仍有效；需补teaching与945原生compaction到worker，不能丢已有能力。
  不做shared SDK卷/亲和部署；worker只恢复本进程确实拥有的SDK session，否则事件cold start。
  Linear948 In Progress、950 Todo已对齐。新UI代码未实施，旧UI preflight已撤回。

- 964工作树 /Volumes/YukovalSBak/yukoval-projects/tlp-wt-mimo-cost-truth，codex/yuk-964-mimo-cost-truth。
  实施25ae0dc4，PR1343；37unit/24runnerDB/reviewPASS/typecheck/lint/build/audit通过。
  正数MiMo SDK派生USD改为catalog公开卡estimated，未知保持null；不重写历史/不改其它provider。
  10条945实际wire免费回放与新成本owner完全相符，无新付费；已合入main8e534d3c，待最新exactCI。
  CI389b365d的4条失败均为旧failed/partial SDK费用断言；改为estimated数值且保留状态/usage/恢复保护。
  root扩大AI目录scoped unit：32files/418tests全绿；PR1343 exactc1afae75 CI34036794558全绿。
  已于13:51:49Z合并main9e02c48b，Linear Done；不删这些高价值失败测试。

- /Volumes/YukovalSBak/yukoval-projects/tlp-wt-native-compaction，codex/yuk-945-native-compaction。
- 产品18702ab9经143scoped/唯一复审PASS；草稿PR1339旧exact821184ac CI34031520139绿。
- 新实际harness8f7a438a、长样本de18fcaa；真实摘要质量已通过两样本。
  PR1339 exact60429d44 CI34035583914全绿，已于13:27:30Z合并main8e534d3c，Linear Done。
  最终集成148scoped/typecheck/lint/build通过，无生产部署。
- 短样本session8e50d9a1-b8dc-42ff-91d3-e2017a703754：1057→1388，不称降本；
  长样本session8709f3db-a35e-4b87-91d3-c2a3981dbf93：11977→1590。
  120个过期学习记录，保留现行3节点/关系方向/数值/来源/未知vs零/未批准更正；
  同session续问有更新learner且不重发旧fixture。native manual compact，不是auto阈值或队列E2E。
- 新$10池估算花费$0.0130696878，保守请求预留$0.90823；此前$0.28771982另列。
  估算基于官方公开USD卡，不是账户账单；旧未知timeout/child仍未知。没有其他新付费调用。
- .env.local无key预检0调用；正确凭据源是原树.env，仅加载不打印/修改。
- 初稿scripts/ai/native-compaction-actual.ts因缺预算/输出/保留验收被root撤掉；
  正式tests/acceptance/native-compaction.ts有5请求/字节/output/90s/预留限制及失败证据。
- SDK autoCompactWindow最低100000；不能用非法小窗口或合成usage声称真实节省。
  learner每轮注入、proposal digest、原权限/6轮/预算不变，rawCoT/summary不写产品usage。

## 949独立实施

- /Volumes/YukovalSBak/yukoval-projects/tlp-wt-primary-view-owner；ADR0061在799ea23c。
- Owner明确FULL，允许按需短control交互；保留3source/agent意图，server最终验证；不提预算、不改UI。
- ea8367c7初稿未完成：初审5P1（read丢hero/任意ref+legacy绕过/durable丢pv/
  删除944prompt关键约束/4个新增lint错误），已在81eb7f3e修复；该agent提交clean并释放。
- root当前独占949工作树，ed693e16已合入main9e02c48b，保留945/964。唯一验证审原5P1已修，
  新发现storage kind无UI导航；root将owner lookup改为canonical ref发布，6DB导航契约与76unit绿。
  208集成unit、49durableDB、typecheck绿。新增4个opt-in actualcases，preflight通过、尚无新付费。
  以上为actual前状态，当前更新：root59156663，唯一验证审PASS（原5P1+canonical-ref均收口）。
  8个shipped浏览器case三类/none、inline/durable与刷新重放均绿；本地server82638已停止。
  949实际7回合estimated $0.0214406071，预留$2.8；新$10池总estimate $0.0345102949、
  reserve $3.70823，安全剩$6.29177。没有付费调用运行中，旧池$0.28771982仍单列。
  成功：process/nohero、tool_result精确真实call_id、author_artifact真实保存后artifact。
  未通过语义：HTML三次错误称关闭消失/未持久化/未写入持久存储，原始模型失败保留。
  只读咨询后root081471e4实施shared commit-owned说明，不做regex删句/模型评估/新增paid。
  writer检查输入hash→追加固定权威保存说明→reseal；durable repair/replay共享，前台清理不一致SDK cursor。
  三条真实终文免费重放policy全部通过；当前322unit/56DB/typecheck/lint/build绿；无第三轮review。
  首个tool actual因root harness JSON键序误判失败，改isDeepStrictEqual复验过；首失败也计费并保留。
  docs/planning/evidence/2026-09-06-presentation-control-actual.json封存全部7个原始终文/digests/runIDs，
  不把结构script pass当人工semantic pass，不持久化CoT。
  PR1345已推cc3afecd；CI34039845298其余lane绿，DB2运行30分钟后取消，未合并。
  新advisory P1确认为同一行题目+答案绕过校验；三例RED，补句首直接指令识别后58unit绿。
  保留实际报告/修辞问句不误拦；等待新提交与fresh exact CI，无新付费、无第三轮review。
- 原implement_primary_view_owner已停止；review_primary_view_owner初审已用，唯一验证审正在收口最后canonical-ref问题，不开启第三轮。
  不信任原worker的完成或“lint错误已有”说法，后者被实际diff和review否证。

## 已交付与下一步

- 961 PR1340 exact69542b2d CI34032977403绿，main50ba305b，48DB/reviewPASS，LinearDone。
- 963 PR1342 exact417623b5 CI34034266076绿，main4034859c，70unit/reviewPASS，LinearDone。
- 962 PR1341 exacta522a60f CI34034085071绿，mainc43d51be，59unit/reviewPASS，LinearDone；
  617unit/426DB共1043文件，不删断言、不移动尚有传递DB依赖或Bun独立测试。
- 944 PR1338 main db5a57b1；五读取actual核心通过，40410vs40401不证降本；960仍开放。
- 964已去重登记：更新MiMo本地占位估算卡与来源，官方价格页2026-08-06已公开分模型费率。
- 既有Pipeline/Goal/Knowledge/Import/execution/ReviewSettlement/客户端状态/测试退休均有合并证据。
  946仅原生catalog/body渐进加载验证Done，不建第二catalog、不删quiz。
- 下一条948/950统一持续会话、960分类器与全业务扩展验收继续；不是当前PR即整体完成。
  960已在独立tlp-wt-report-question-boundary修复并推PR1344 exact960d0b64：29unit+全部localgates+唯一复审。
  CI34038363273初次仅旧proposal-tools归因DB超时60s+后续preparedstatement错误；精确两例本机通过，
  已重跑failed lane，同类原762已去重重开Todo。两次worker把新format errors错说baseline，被root纠正。
  PR1344同exact失败lane重跑后全绿，已合并3791bf4d，root已合入949树。
  210c6051恢复原mid-line问句锚避免无意扩大检测；与949一起交付，不改变实际报告修复。
- 依赖438/0/47与5capability SCC/20命令消费者保留；不为数字重做已封装learning-intent。
- 不动原始脏main、不部署/改SoT/backfill/删历史；887需独立生产副本授权，
  951需完整drain窗口；921/572/832HOLD不解锁。
