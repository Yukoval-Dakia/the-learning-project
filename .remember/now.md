# 当前 handoff — 2026-09-07，完整重构goal active

## 最新状态

- YUK975 Done：PR1359 exact14ea1a8142c867e3b95c619a8441b6d56b65695d，CI34128362101全job success，
  main5e65629170d1ef48dfcc8e964bfa64d42f9bc691，独立初审PASS（独立8unit/7DB/typecheck），无需第二审。
  API缺少信号owner：baseline fbee5c32同clonehealth200/stop137，唯一--init对照143；新bundle0。
  clean14ea1a81实际SSE200，server30s强制断开、client90s未abort、30319ms/exit0；clone423/24/258/4不变。
  首样本client45s与server30s撞期不作强制断开证据；四个已停止临时probe容器已删除，无用户数据卷。
  API单owner先HTTP30s、await worker startup、共享boss30s/WIP日志、DB end；总65s，compose API70/worker40。
  49unit（12shutdown+37Copilot）与7既有DB分区shutdown、typecheck/lint/build/partition/architecture通过。
  未为测试分区放宽audit；尝试移动旧boss test被拒绝后已撤销，保留原DB分区。
  Mac13:48Z app/worker运行14ea1a81，image sha256:c4ea66c85bc08dd40d1705c6fdbb24cc00b546f5d4306b9448b6620f431569f8。
  healthy/零重启、实际StopTimeout70/40；原PG ID7d99236a/StartedAt09:40:42Z及pgdata未变，无NAS/tunnel。
  clone/live migrate零新增、8类audit/golden零drift；423event/258task/4attempt不变，无活动/待执行队列。
  health200/无token401/有效token200；未为验证stop而额外重启新生产API，隔离停机与生产运行证据分开。
  private runtime-975-image.override.yml生效；回退用fbee5c32/runtime-972-image.override.yml，保留原backup。
  root独占codex/yuk-975-delivery-notes，原脏main不动；无paid，恢复专项$3未用，旧$10safe0.04177不回收reserve。
  下一项成本真相/全产品扩展成本复核；887完整provider/crash、951完整重试窗drain仍开放，整体goal active。

- YUK972 Done：PR1358 exactfbee5c32c8077f9cda18f7f8953c49367f36184a，CI34126257359成功，
  main4c9ae238eb74d9d4db062a1ab0a5756b9dfc8b93，独立初审PASS无P0/P1；不需第二审。
  Mac于13:24Z运行fbee5c32镜像sha256:d271e3c9b266bfcd5cf58ef1bf8e22a7332680d20ae3a72f4ae53d6cbad60e87。
  app/worker healthy/零重启，原PG容器/StartedAt 09:40:42Z及volume不变；无NAS/tunnel/paid。
  clone/live迁移零新增，423event/258task/4attempt不变，queue active/created/retry=0；8类audit/golden零drift。
  回退仍可用034f35fe与private runtime-974-image.override.yml；本次只换runtime-972-image.override.yml。
  不涉及schema，沿用最近974前备份，未新dump；空goal/variant/QB不称有数据canary。
  只移除unit_dimension的physics名称门，custom profile行为验证；不新增schema/产品学科/模型调用。
  两路由RED→GREEN，真实registry/alias与完整profile验证；override/choices/图片/未opt-in以及内建矩阵保留。
  51unit/typecheck/lint/build/architecture/capability过；CI migration/usability按变更跳过，不称新浏览器验收。
  两处直调judge职责分别是照片作答和独立解答对照，未证明同一规则重复，不机械删除。
  root独占codex/yuk-972-delivery-notes，原脏main不动；专项恢复$3未使用，旧$10安全余0.04177不回收reserve。
  当时887捕获shutdown：第三次正常compose stop旧034f35fe仍十秒后exit137，worker exit0；现已由上方975交付。
  server/index.ts仅RW_WORKER=1安装boss shutdown，生产RW_WORKER=0；serve返回值未持有，compose无grace。
  先隔离真实binary复现，未确定PID1影响/未证明数据丢失；887comment7b8306d5记录，勿混入972。
  整体goal active；provider/crash矩阵、成本真相、951完整重试窗drain仍不能冒充完成。

- YUK974 Done：PR1357 exact034f35fe，CI34124354408全job绿，main c27202369，Mac部署已验证。
  hub-sync两钟漂移与提案artifact撤销早于新编辑均RED→GREEN；Notes拥有整笔归档，Agency不再写artifact表。
  8未登记/5stale逐项事件责任复核；code-policy替代静态LIVE，0violation/0stale，42advisory不隐藏。
  初稿120DB/27unit/typecheck/lint/build/严格writer与架构通过；当时生产仍4e1dec7c，无paid。
  初审64a94b71 P1：旧润色读v0后在archive后CAS仍成功；真实PG交错RED→GREEN，archive推进version+事件。
  CI34123408875双DB绿，仅Step9旧名单失败；两份重复名单用同scanner/registry替代，保留原2表硬门。
  修后101DB/46unit/typecheck/lint/build/architecture过；唯一验证审034f35fe PASS（独立5DB），无第三轮。
  app/worker运行034f35fe，healthy/non-root/零重启；原PG容器/volume不变，无tunnel/NAS，live迁移零新增。
  423event/7LI/8artifact/258task/4attempt不变，live audit与8golden零drift，browser认证/抽屉/刷新重开无pageerror。
  新backup loom-before-974-034f35fe.dump，镜像clone迁移通过；回退可用原4e1dec7c镜像/973 image override。
  root当前codex/yuk-974-delivery-notes仅交付记录，无paid/$3恢复预算未用；下一项972，整体goal仍active。

- YUK973 Done：PR1356 exact4328ab89，CI34120804982全绿，main21bc94dcf，Mac部署已验证。
  Goal/LI/variant主双轨分支、三旧env/compose开关、LI inline legacy genesis已退休；legacyGoal仅fixture入口移tests/helpers。
  typed Q1 knowledge_ids_rewrite支持live pre-rate及backfill/sweep；共享repair操作包住anchor/事件钟/append/project。
  补漏completion/relearn retract raw writer，typed state_restore携带exact prior状态/完成时间，保留evidence清理和状态guard。
  事件钟保证晚补base/同钟串行rewrite不丢；归属repair不改版本/updated_at/derived。
  312 scoped DB、64 unit、typecheck/lint/build与capability/architecture/flags通过；依赖437/0/47，仅下调2。
  raw未准备fixture曾触发guard：修为先真实迁移再提案，不放宽migration的eventful-unanchored拒绝。
  PR1356 exact28e05daf初审P1：correct时钟早于锁等待期间提交的mutation。root两目标RED，补LI archive第三RED，有限事务重试后3GREEN。
  整笔旧correct/outbox rollback，复用逻辑id并推进到locked updated_at之后；batch取最大时间，最多3次，持续冲突409。
  修后101相关DB、typecheck/lint/build/architecture通过；CI34117592341两个DBshard各1raw fixture未迁移，其余4922过。
  补completion approval与placement coldstart真实迁移后4项过；唯一验证审4e1dec7c PASS（独立67 DB），无第三轮。
  CI34119067574仅旧deadline cleanup要求DB在50ms完成失败；注入语义钟并补终态signal不abort，26DB/15unit过。
  镜像4e1dec7c已部署（tip后续仅测试/文档），app/worker健康无重启，原PG容器/volume不变，无tunnel。
  新备份loom-before-973-4e1dec7c.dump已实际恢复loom_before_973_verify；live migrate零新增，7LI就绪。
  live423event/258task/4attempt不变，hydrated audit与8golden零drift；browser认证/抽屉/刷新重开无pageerror。
  audit-fold-writes其它实体8未登记写点+5stale已去重登记YUK974 Todo，不新增allowlist；972继续Todo。
  原脏main未动，无模型调用；额外恢复$3未用。root当前codex/yuk-973-delivery-notes仅交付记录；下一单974，整体goal active。

- 973迁移前置历史记录（已由上方完整交付状态取代）：codex/yuk-973-canonical-writers；helper已实现并接入migrate.ts。
  三类实体在同一锁定事务补锚，拒绝orphan history/field drift/ghost，失败回滚新锚，不live rebuild。
  51相关DB与typecheck/lint/build/architecture边界过；fresh/锁超时/重试/并发/派生列覆盖。
  初审发现index-only dangling origin漏检P1，三实体3RED后修复；正向真实goal撤回链仍通过。
  唯一验证审465261ba PASS（独立22DB）；root随后实际bundle对照发现并修复静态import加载.env导致显式DB目标门弱化。
  新增真实bundle+child unit保护；review预算已用完，不开启第三轮；最终exact-head CI仍须通过。
  PR1355仅迁移前置，不关闭973。
  实际dist/migrate.cjs在loom_refactor_verify_sjuacu连续两次成功，seed0/LIchecked7；未改生产/新增模型调用。
  真正writer/flag删除仍未实现，后继必须完成，不能将此迁移前置PR当973或整个goal完成。
  设计/剩余验收见docs/planning/2026-09-07-canonical-state-writers.md。

- 887 Mac本地切换完成：PR1354 exact0ed35fd3/CI34108722202全job绿/reviewPASS，main a12667507。
  API+worker运行clean55aaac30镜像sha256:00e6595f0d590c18a0c7ecd02fa7f08c857c4fa87942665cf985260a1048cbfd。
  三容器healthy，原PG volume未换，API127.0.0.1:8787/RW_WORKER0，无cloudflared。
  运行后hydrated audit八类零drift；真实browser认证/抽屉/刷新恢复/summary稳定通过，截图external copilot-live-settled.png。
  无新增模型调用，258task/4attempt保持；7个历史恢复是错误推断，精确pending/synthesize均0，追加$3未使用。
  887自动Done已纠正In Progress（全部provider/crash矩阵未完成）；下方启动待办均已被本条取代。
  973下一单active线：迁移前置补锚、退休Goal/LI/variant双轨writer及重复测试，保留真正安全契约。
  972已登记Todo；NAS仍不在范围；原始脏main不动。

- 2026-09-07 owner新授权「直接动本地生产即可」覆盖Mac本地生产操作，不包括NAS；下方旧未授权状态已取代。
  root当前codex/yuk-887-local-production，base main55aaac30；971已PR1353合并/CI34106719123 docs-only success/reviewPASS。
  OrbStack原Stopped已启动；唯一既存容器the-learning-project-postgres-1，volume the-learning-project_pgdata，DB loom @127.0.0.1:5433。
  app/worker均未运行；94migration/31MB/12KC/7LI/8artifact/391events。保留1failed memory ingest及1created DLQ，不自动重烧。
  备份/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/loom-before.dump，sha256=13310b8c88e1d03b5bbc71f9b0ea2b67a55e68f1cf40788936def75054a3a040，pg_restore目录可读。
  dump已真实恢复loom_refactor_verify_sjuacu；clone迁移+B3所有cluster GO，8个external goldens birth0drift。
  live migrate94→101（builtintraits升级8）；genesis新增9KC+22calibration，重复0新增；live audit0drift/outbox0。
  live实体12/7/8不变，events391→422；未live rebuild，无新增paid，item_calibration始终OFF。
  77学习闭环DB+36B3/backfill/golden DB通过，typecheck/lint/build过；Mac flags补goal/variant/LI两角色，待PRCI。
  Docker build session68471从clean git archive55aaac30运行，context=tlp-image-55aaac30.fnMhiI，tag the-learning-project-app:55aaac30。
  部署必须-p the-learning-project；runtime override在上述备份目录，external原pgdata/mem0data/network，DBpostgres:5432/loom。
  API/worker尚未启动，pending memory失败/DLQ不重烧；副本/B3保护不可绕过，NAS仍未授权。
  972已查重登记Todo（physics名称特判阻止custom unit_dimension）。另一direct judge候选待核，不把solve-check误判为学习判分重复。

## 旧授权边界及971实施记录（以上方为准）

- Active971：root独占tlp-wt-unified-conversation / codex/yuk-971-current-agent-guidance，base main07280e6b。
  三份现役指引纠正自动VLM baseline/额外rescue、Notes artifact归属与FULL呈现；仅文档。
  6个本地链接/7项文档unit/typecheck/lint/build通过，待独立review/exactCI。
  970已PR1352合并：exact46a237c4，CI34066586538全绿，main07280e6b，LinearDone；15unit/103DB及review/gates通过。
  未部署、无新增paid，整体goal active；全历史ADR审计未完成，生产副本/SoT退休仍须独立授权。

## 970历史实施记录（已由上方合并状态取代）

- Active970：root独占tlp-wt-unified-conversation / codex/yuk-970-tool-contract-tests，base main15eceba0。
  Agency/Ingestion整体schema迁移指纹与自测、Agency/Copilot纯搬迁路径断言退休；effect/cost/mirror显式保留。
  15unit/103DB及architecture/capability audits/typecheck/lint/build通过，独立初审PASS无finding；待PR/exactCI，无产品/paid/生产变化。
  762实际已PR1351合并：exact36da8192，CI34065494164首轮全绿，main15eceba0，LinearDone。
  971已查重登记Todo：三份现役Ingestion/Copilot AGENTS仍有与VLM baseline、Notes工具归属、FULL presentation冲突的约束。
  三业务owner复核无新增重复规则；Practice同步/队列判分不等于Copilot产品分前后台，不为此造新wrapper。
  audit-drift自动模式未完成全ADR读取/查证，不得宣称完成全量审计，不生成审计专用文件/PR。

## 762历史记录（已由上方交付状态取代）

- Active 762：root独占tlp-wt-unified-conversation / codex/yuk-762-db-context-identity，base main5cac4753。
  CI34064877513原同一归因case60s超时后preparedstatement错误复发；两例本机通过，失败lane第二次绿。
  后续临时时序探针证实14460ms中14390ms耗在toMatchObject深遍历Drizzle连接，不是已证DB锁/资源原因。
  改taskCtx.db.toBe(toolCtx.db)并独立匹配profile后同case34ms，23项全文件DB过（test body1.47s）。
  不放宽timeout、不删行为断言、不改产品代码，临时时序探针已移除；typecheck/lint/build与初审PASS，待PR/exactCI。
  PR1350 exacta290eafed56c283e088a7e8f0a8e3646e81cba44，CI34064877513 attempt2全绿，
  2026-09-06T22:54:49Z合并main5cac4753cd2e8235562eddab2ece3d6618d3e56d，967/969均Linear Done，未部署。
  全ADR漂移审计未完成，不作全量结论；已核验SoT退休前置条件并更新887/951，生产副本/部署仍未授权。

## 967/969历史实施记录（已由上方合并状态取代）

- Active 967/969 integration：root独占tlp-wt-unified-conversation / codex/yuk-967-969-integration，
  base origin/main5bd921e3；已逐提交cherry-pick隔离lane，88a7f10cc，无冲突，无其它writer。
  967知识读取owner明确not_requested/no_returned_nodes/observed及限定absence资格；stats30d与failure历史latest10分开。
  12readerDB+34snapshot/fixtureDB/typecheck/lint/build与独立初审PASS。
  clean5717bcbd原presentation-tool actual通过，one root/read/presentation，无凭空失败记录断言；
  live/persisted同1502B snapshot，input41516较旧41280多236，不声称降token或费用。证据knowledge-observation-actual.json。
  969题池pass+copyunknown已真实DB RED→GREEN，不晋级/不FSRS/不继续paid validators，rawunknown保留；
  37DB/typecheck/lint/build与独立初审PASS，未改learner-visible特殊政策或旧solver保守政策。
  两lane均完成初审，无P0/P1。root集成100DB/41unit/typecheck/lint/build及架构gate通过，PR1350。
  首轮CI34064358949仅旧knowledge整体schema哈希失败，其余全通过；本机复现后退休迁移指纹与其自测，
  保留manifest加载、effect/permission并显式断言cost/mirror政策；3unit/typecheck/lint/build通过，待新exactCI。
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
