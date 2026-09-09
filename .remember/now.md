# 当前 handoff — 2026-09-07，完整重构goal active

## 最新状态

- 09-09 887 actual：默认GLM上传/R2字节/物理worker/Structure/3卡结构+独立fold全PASS；sourcefea051244 runtime等e514，worker仅改两provider端点到限额proxy。firstv1先API派发无queue500、0model；v2workerfirst成功。
  v2 fresh DB loom_upload_887_glm_v2/sessiono5rh2hz5evs9tq2plsn1jdfr/job331e2c6f-3137-4a96-b927-b5245d59038d/Structureoyx84ypkqyqdxb2y81rzzed7；GLM740/272估0.0002024CNY，mimo2865/600估0.0005691USD。3fold diffs[]；无auto_enroll。临时容器stop+rm，DB和R2合成对象保留；生产454/280/21不变。
  Tencent executeSubmit真实SDK1次，afterJobSaved SIGKILL；新进程同operation读JobId1489202432483262464无新submit，6Describe仍RUN，之后同Job一次Describe DONE。实际provider-owner进程恢复，不冒充Tencent物理worker/结构质量；8attempt costunknown/null。
  新$10reserve总4.70/余5.30，证据hash详rollout-evidence-gap.md新头部。map_copilot_live_crash_canary只读盘点剩余item7，不新付费；默认已通过样本不重跑。

- 2026-09-09 owner明确新授权10USD，887已恢复In Progress；不是旧池回收。root预算初始0reserve，先当前默认GLM真实上传/OCR/Structure，控制出口每provider一次，fresh隔离DB/合成试卷，不动生产worker和历史任务。
  Docker现三服务e514ef94/PG healthy但均近期重启，勿沿用09-08 StartedAt；实际验收前重新快照。目标尚未完成。

- 887免费准备：明确canonical assets→ingestion-sessions→operations(kind=extract,idempotency)→OCR worker，而非旧extract URL；offline复杂worksheet PNG已渲染目检，hash见rollout-evidence-gap.md。
  未upload/R2/worker/paid。独立只读audit_final_business_ownership对录入完成/判分完成/知识合并三行为未找到剩余规则复制或跨owner内部写；root复核durable receipt同事务、三个settlement共用效果、merge最终故障跨域回滚断言。
  root architecture-deepening通过49Task/42Tool/53queue/19proposal、428/0/48，5域SCC21command仍如实保留，不用数量证明责任封装。无新runtime代码缺陷/不用开新issue；887实际上传OCR与恢复gate仍未完成，$2预算请求仍待答复。

- 951 Done：PR1370 exacte423a56e4/CI34236331582 success（docs-only跳过代码lane，非重跑全测）/main8ea58bd4，14:09:16Z合并。
  初审发现canonical-knowledge当前/历史状态冲突，改显式历史非操作指引+过去时；唯一验证PASS，不第三审。build/diffcheck过，无runtime部署。
  root转codex/yuk-887-final-evidence，从新main建；原脏main不动。887当前e514镜像proposal clone HTTP接受/驳回/撤回/幂等通过，accept/retract独立fold零drift，详见rollout-evidence-gap.md末。
  canary tlp-887-canonical-proposal已stop，clone task280/attempt21无增；生产454/280/21/0queue不变。当前worker GLM默认且所需凭据presence齐备，非网络认证/真实OCR证据。
  已异步询问新最多$2默认引擎上传/OCR/Structure验收授权，尚未获答复，未paid；Tencent永久可选引擎JobId恢复仍需单列，不能用GLM成功替代。

- 951最终名词处置补入ADR0063：persistent conversation/turn/native child/tool call；保留subagent_run当前投影、live remote ToolOperations、copilot_continuation历史schema/export/readiness，不做物理名合并或Mission表面。
  root核对manifest仅现役run/reconcile，mcp-bridge仍调用getProcessToolOperations，native同parent结算/取消及turn reader仍在；文档集成尚未完成，951不能先报Done。
  本轮Mac app/worker e514ef94、PG三服务healthy，health200；未重启、改生产数据或付费，旧预算reserve不回收。
  下一文档集成和887真实上传/OCR/恢复差集；原脏main始终未动。

- 984 Done：PR1369 exact e514ef94a5f8032e21a8afbe9864294538b5b935 /CI34233241153终态success全job绿，初审PASS无P0/P1；13:52:31Z merge main e9b6f2516dc4595bf3cb4eae1a179c4403fed78f。
  13:53:04Z Mac app404dd2cbf5be67b63fb47bf25fde5b7b0814050793b067e708e09a063ade9d87/worker8250610adcddc02d017eed9a1eea0c1192a45d3d671b218d549bc2daa4b4a530运行e514ef94 healthy/0restart。
  原PG7d99236a/09-07T09:40:42.502Z和volume未动；live migration七实体0新增、12knowledge/7LI/8artifact通过，454event/280task/21attempt/0queue未变。
  live health200/无token401/knowledge200/7notes200、真实browser note读取/reload零pageerror。8 retained golden再fold零drift：knowledge12/LI7/artifact8/calibration22；其余4kind空，不冒充复杂内容覆盖。
  私有knowledge984-deploy.log/live-migrate.log/live-check.log/production-check.json/production-reader.png/retained-goldens.log归档；runtime-984-image.override.yml生效。rollback须旧release/compose/983镜像，不能翻已删flag。
  Linear984已Done，clone测试数据保留；没有新增paid/NAS。root现codex/yuk-984-delivery-notes，从新origin/main接回3交付记录commit，原脏main不动。
  整体goal仍active：下一951保留处置/887实际上传OCR与恢复差集/逐学习行为最终验收。各旧paid池已保守预留完毕，继续免费验证，不能重烧failed任务。

- 984继续等待同一CI34233241153：两DB shard仍in_progress，其他job全部success；未restart/workflow重跑，未merge。
  私有deploy984.cjs/runtime-984-image.override.yml已准备，preflight PASS（image e514ef94三service一致、精确原PG、队列0），未执行deploy。
  部署入口检查PR1369已MERGED与CI exact e514成功，之后才stop app/worker→migrate→up，保留旧983overlay和镜像作恢复。无paid/生产变化。

- 984 PR1369 OPEN，published exact e514ef94a5f8032e21a8afbe9864294538b5b935；远端main7cccb335。CI Gate34233241153当前in_progress，仅DB双shard未终态，其余productionbuild/unit/typechecklintaudits/migration/usability成功。
  首次正式整项review agent /root/review_984_canonical_knowledge 终态PASS，无新增P0/P1；parent-lock候选按既有archived-ancestor语义撤回。初审预算已用，无P1不需验证审；旧fold头注释P2非阻塞，未另开微小issue。
  fresh dump loom-before-984.dump SHA14d0a533c49b6c2bbe6b3f8252dcda9277fd82f105755664d3d682b707a1128e实际恢复loom_before_984_verify，454event/280task/21attempt与生产相同。
  image e514ef94 SHA1a68f9042daaabe160c1ee2e4aa4e8b81405de06a3c2ebbd005af50d9f6f0ad0实际dist/migrate PASS，7实体0新增/12knowledge/7LI/8artifact检查过。
  clone shipped HTTP admin math rename200，revision0→1，knowledge tree根name同步，旧revision再写409；停专用HTTP容器后再迁移PASS。clone455event/280task/21attempt；production仍454/280/21，零provider增量。
  production app18e9a5e2/worker2377d637仍5dd7e8ed、StartedAt11:46:55Z/0restart；PG7d99236a仍09-07T09:40:42Z/0restart。无生产写/付费/NAS。
  私有证据目录tlp-local-prod-20260907.sjUaCU：knowledge984-image.log、knowledge984-clone-result.log、knowledge984-http-result.log、knowledge984-clone-after-http.log与两cjs。HTTP容器tlp-984-http-clone已stop未删，migration容器--rm。
  13:47Z复核同一CI run仍in_progress，DB双shard未终态，其他job成功；PR API inline comments空。下一读取同一CI，不重开review/CI。exactCI成功后可merge与Mac交付；local交付记录commit未推，避免纯docs重置CI。

- 984全局flag退休完成：projectionIsWriter必须显式entity，knowledge/edge各自canonical；env schema及tracked Mac compose删除全局开关。README明确七实体历史gate/旧release rollback；calibration方案A不动。
  删4重复ON/OFF proposal tests/stripVolatile辅助，保留真实接受字段/并发/缺历史/回放。oracle预期改七实体always-on，仅calibration gated。
  76DB、3policy unit、typecheck/build/lint与boundary/deepening/fold strict通过；lint316 warnings/1info但exit0，未扩大清理范围。
  gh preflight auth可用，远端main仍7cccb335，984无已有PR。准备首次整项PR/review/CI，非已交付；局部锁序核查不算整项初审，整项review预算尚未用。
  生产983仍不动，无paid/NAS。下一clone fresh backup实际migration/browser/readiness后按授权Mac交付；整体goal active。

- 984知识历史迁移已实施：migrateCanonical锁表扩knowledge/edge，先validateKnowledgeHistory，再7实体backfill+正反fold/live审计。Q2间接propose/split要求原accept/materialized IDs/index；Q3 merge全部from/into须base。
  pending proposal不算结构历史；archive-only edge拒绝。edge真实rate subject为knowledge_edge、rating reverse/change_type等，单独验证生成effect，不能套node rate.subject=event约束。
  接受envelope/原创建schema重用、malformed action/identity拒绝；split/merge判别从action补入，和现fold相同。孤立materialized accept即使proposal+index都丢也拒绝。
  95DB及四套73DB复验过（含actions/backfill caller），最后9历史DB/typecheck/build全过。
  初轮2旧report fixture只列5实体，补7实体精确断言；另两新fixture缺id/时间已修；schema初误传DB nullable envelope、未补mutation，按真实fold输入修正。无生产/付费变更。
  下一全局PROJECTION_IS_WRITER物理退休、整项独立review/exactCI/clone+Mac交付；未完成，不把local migration gate当生产验收。

- 984四创建入口已共用node-creation.ts：LearningIntent/seedKnowledge/ensureSubjectRoot/placement调用同一create lock→已存在skip/error→genesis/index→projection。
  保留actor、placement确定性genesisID与旧身份/历史检查、ingest_at；已有节点不改/不补假历史，history有row无则拒绝。业务src知识结构DML只剩projection，两个embedding派生writer保留。
  四套44DB、补三套26DB（跨bootstrap/root并发只诞生一次/ghost拒绝）及typecheck/build过。fold strict无violation/stale，删除8旧writer声明，proposals归derived maintenance。
  依赖baseline如实428/0/48：Knowledge创建锁新增1，对projection引用少6；Practice新增1明确Knowledge创建命令替换原跨域raw INSERT，不用kernel转发隐藏。catalog关联984，架构/边界过。
  audit unit首1fail仅引用已删除seed registry fixture，改现存artifact/question_block advisory样本，最终28unit/typecheck复验过。
  下一知识部署历史Q2/Q3/全局flag退休与984整项reviewCI/Mac交付。无paid/生产变化，原脏main不动。

- 984科目改名/重置root name已删raw UPDATE，保留控制面revision与节点FOR UPDATE→锁后时钟→event→projection。
  requireKnowledgeHistory从提案私有提至现有knowledge projection模块，两真实consumer共享严格guard；缺base/结构漂移阻止改名并回滚subject/revision/journal/events/root。
  两套79DB与补充10控制DB/typecheck/build过；旧未使用isDeepStrictEqual import删除。下一三创建入口seedKnowledge/ensureSubjectRoot/placement-starter合并创建责任，保留各自幂等/来源。
  未984正式review/PR/付费/部署；production983仍不动，部署历史/Q2Q3/globalflag与交付仍未完成。

- 984 LearningIntent创建已canonical：knowledge owner创建genesis/index再project，无raw INSERT；Agency两调用传接受rate因果ID，保持ingest_at outbox optout。
  create-only id锁与existing guard避免projection upsert变成覆盖。3a真实接受验证root+child fold/index/因果、Notes失败全tx回滚、无需backfill即可archive。
  两套56DB/typecheck/build过；最终重复ID护栏含14DB/typecheck复验过。下一统一seed/ensure-subject-root/placement-starter三处INSERT和subject-control-name UPDATE；已root实查都有配对event但仍raw结构写。
  保留embedding派生writer；迁移当前5实体缺知识Q2/Q3历史校验。没有新增付费/生产变更，正式984 review/PR/交付尚未开始。

- 984 merge已canonical：私有prepareKnowledgeMerge锁内校验全部from/into历史与结构漂移→9归因修复→完整immutable rate receipt→统一projection。
  applyMerge raw导出/两处node DML/accept flag与warn-only parity分支删；仅embedding派生UPDATE保留。重复from与错误subject拒绝。
  原raw测试改真实accept并按精确proposal读取receipt。四旧fixture缺base已显式准备；seed无历史先拒绝且不删行再准备成功。
  trigger证明节点UPDATE前有完整merge receipt；missing/drift/target guard全回滚。4suite131DB/typecheck/build过，首无结果runner退出1后单suite重跑定位4fixture（63pass），非生产故障。
  下一部署历史/全局flag物理退休；map_984_history_retirement只读盘点在跑，无第二writer。未984正式review/PR/paid/deploy，生产983不动。
  盘点已返回，root实查learning-intent-knowledge.ts仍raw INSERT，Agency learning-intent.ts两真实create调用未补knowledge genesis/index；下一先收口此遗漏owner，再部署校验。
  不直接采纳子agent“subject control raw UPDATE应保留”判断；需按唯一结构writer目标另核subject seed/root控制面。migrateCanonical目前仅5实体，Q2/Q3须专门验证。

- Active984：root独占codex/yuk-984-canonical-knowledge（从983交付docs8c901df3建），原脏main不动。
  关系新建提案已删flag-off直接INSERT；共同runEdgeTopologyGate固定projection，保留锁/retry/错误翻译，不再生产warn-only。
  37相关DB过，新增INSERT-trigger顺序验证含所在文件11DB通过；typecheck/build过。仅实施checkpoint，未审查/PR/部署，生产仍983/5dd7e8ed，无paid。
  edge全event→projection；node新建/tagging/reparent/archive/split已迁移，余merge结构DML及部署历史/flag退休；不保留永久旧writer作rollback。
  最新127DB/typecheck/build全过；archive/split删节点DML，撤回真实consumer也prepare→event/rate→project，public raw archive导出删。
  原子性case发现投影可覆盖out-of-band漂移：现在reparent/archive/split锁内严格比对结构fold/live，派生embedding排除，缺历史/漂移全回滚。
  历史fixture时钟在genesis前设置、accept时推进，无事件UPDATE；初始SQL日期probe失败无生产写入，已删除。split测试通过真实accept并保持minted IDs/时间/边关系断言。
  map_984_node_order只读结论已返回，root复核9归因owner不依赖from节点先归档；可准备完整repair receipt后再投影，尚未实施merge结构DML删除。
  已修accept merge在knowledge行锁之前取learning-state全局锁；原内部applyMerge取G太晚。真实accept/pg_locks回归及两套77DB/typecheck/build过。
  本轮仅锁序有界只读核查，不是984整项正式初审；无PR/paid/deploy，生产983不动。
  有界锁序核查无P0/P1；临时删fix后新case精确RED（knowledge relation lock 1≠0），已恢复；helper finally释放G并drain两事务。
  最新reparent126DB+7guard/typecheck/build过：旧结构UPDATE删，锁内CAS/base校验→accept projection→新位置embedding/hash维护，derived不再写updated_at。
  tests/helpers/knowledge-mutation.ts显式fixture backfill再走真实提案/accept；旧raw applier测试迁移，缺历史/错误subject/并发相同version均有行为护栏。
  两旧fixture缺base已补；race暴露insertProposeEvent伪造subject_id，改按mutation导出真实subject并在accept检查targetbinding，最终双并发只有1提交。无paid/生产变化。
  本轮117DB/typecheck/build过，最终接受节点字段3targetedDB过。prepareProposedKnowledgeId只校验父+分配ID，无直接INSERT/writeRow模式；tagging删flag/parity分支，接受新节点固定projection。
  旧准备函数写表断言移至真实accept，准备阶段断言无node/event；原自动批准/缓存/来源契约保留，无paid/部署。下一reparent embedding/merge/split顺序。
  最新7suite/212DB/typecheck/build全过，gen:postman无diff。create/reactivate原始DML及API/merge/supersede配对generate删除，保留replacement event ID。
  首192case有1旧fixture revival早于creation；改真实创建/归档历史，owner锁内推进事件时间。同clock三连操作严格顺序回归过；ingest_at optout独立保留，无paid/生产变更。
  只读map_984_node_order已终态；其“保留imperative rollback”建议与owner目标不符，不采用。节点顺序结论须root逐项复核。
  archive proposal已改锁行→校验base→rate/archive→projection，无直接UPDATE或flag。59DB/typecheck/build过；显式排除archive-only假基线后42actionsDB及typecheck/build复验PASS。
  生产只读edge count0；不把空人口当复杂迁移验收。supersede需要先移除旧边再gate新边，重构owner时保持同tx；其它raw writer尚未改。
  archiveKnowledgeEdgeFromEvents共同owner已接proposal/cascade；封装tx/lock/base/event/projection，cascade不再读edge内部/拼事件，保留cause/time/ingest_at。
  raw archive函数现已物理删除；内部incident/merge/supersede全用共同owner，删重复archive事件helper与inline genesis。supersede先archive旧边再引入新边，同tx。
  最新145DB+20edge-ownerDB/typecheck/build过。初10fixture缺历史失败已显式seed，旧自动backfill测试改先拒绝/回滚→准备历史→保持所有字段/回放断言。
  61集成DB过；旧cascade空create payload补真实字段/actor/time，最终19cascadeDB/typecheck/build/changed lint过。生产未动，无paid。
  Linear已恢复且list_comments确认上轮comment未送达，本轮统一补记59/42DB和共同owner进展；984仍In Progress。

- 983 Done：PR1368 exactc97eddad098dc80ddd84491ec1218daf85b4e38f/CI34221548520所有job绿，11:46:41Z main7cccb335eb1a4f4d2026198e9e3fac39a393246e。
  Notes及全部六题块编辑统一event→projection；历史完整性迁移/rowlock/CAS/backlinks保留。初审2P1修复，唯一验证PASS，禁止第三审。
  68相关DB/18迁移/9oracle/61unit/27提案DB与typecheck/lint/build/audits过；首CI三fixture缺genesis，补两行准备后全27过，未删除断言。
  实际5dd7e8ed镜像与最终生产代码相同；fresh dump已恢复，clone HTTP保存3→4/旧版本409及后续projection迁移全部PASS。
  前两HTTP probe缺client source镜像而断言失败，已用真实client-shaped输入修正；不冒充产品修复，clone写入未删。
  11:46:55Z Mac app18e9a5e2/worker2377d637均5dd7e8ed healthy零重启，原PG7d99236a/09:40:42Z与volume未变。
  live迁移零新增，7LI/8artifact完整；454event/280task/21attempt/空队列不变；health200/无token401/7notes200/browser读取刷新零错误。
  首live probe误用events表名，改event后PASS；没有生产业务写入。private notes983-production-check.json/reader.png。
  runtime-983-image.override.yml已生效；rollback需旧release/compose与旧镜像，不能只翻已退休flag。dump与旧镜像保留，无NAS/tunnel/paid。
  root独占codex/yuk-983-delivery-notes，原脏main不动；后继984已去重Todo，知识/edge结构双轨退休；887 actual差集与951保留项仍开放，goal active。

- 982 Done：PR1367 exactf707ca5c/CI34217359805所有job绿，10:51:28Z合并main e095d28680cf8e745b071e6f564f4e9ebd29af14。
  Mac10:51:33Z只重建app3e5db502，imagef707ca5c/c122d97d healthy/0重启；worker c430a928/PG7d99236a未动，454/280/21/空队列未变。
  health200/无token401/notes200七条、真实reader/reload零错误；built实际check正文重放与编辑/undo/save/reload/conflict/mobile过。
  独立初审无P0/P1，不需要第二审；27unit/typecheck/lint/ratchet/build/全部local audits过。
  root当前codex/yuk-982-delivery-notes仅交付docs；runtime-982-app.override.yml为新增app-only overlay，回滚去掉此层。
  无新增paid/schema/NAS。剩余887上传/OCR等actual边界与951保留项继续开放；本轮未新发现需独立建issue的实质项。

- Owner批准982七文件FULL预检；root独占codex/yuk-982-self-explanation，原脏main未动。
  check自解释复用现有reader/rich editor，保留id/五kind/乐观锁；不恢复判分、mastery/FSRS、模型调用或新slash命令。
  27unit/typecheck/build/partition/capability通过，独立初审无P0/P1；built浏览器fixture桌面/mobile编辑/undo/save/reload/conflict过。
  当前待exact-head CI/交付，未部署982。忽略的验收TS已归档private，避免临时脚本干扰repo lint。
- 887 Ingestion/Agency actual PASS：源码3582ab884，image8bce5f0a，新DB loom_import_plan_887_actual_v1。
  Tagging h2p42dbhmj2gmutvvkg0nu1m→显式选择tag→completeIngestionImport question ey7rsk7flmua801g0tz0weet；golden diffs[]。
  LearningIntent maqegljxethl9jic861g6spq→proposal fhs89tf6jz95bqxrer0wp038，未自动accept、0学习项/产物。
  两真实wire共estimate$0.00224054（非账单），保留$1 reserve；新$3累计reserve$3/余0，旧reserve不回收。
  post-extraction fixture，不冒充文件上传/OCR/R2；生产454/280/21未增。证据与hash见887 rollout doc。

- 887 learner judging actual PASS：源码2a9638183（runtime代码与8bce5f0a相同，差异仅交付文档），image8bce5f0a，新DB loom_judging_887_actual_v2。
  当前createAttemptResource /api/attempts真实Request→SemanticJudgeTask xhql6qtd7nybtdooy3w0c0ic→201/correct/good（原rating again），review clf6tik0bhrn7u266rjtjgke、judge yq1t2m1op421zb84e0wkt7jd因果链、knowledge FSRS reps1/due已核对。
  实际MiMo830in/278out、estimate$0.00060291非账单；此轮预留$1，新$3总reserve$2/余$1。v1本地代理URL查询参数拒绝、0上游/0reserve，不记产品失败或模型费用。
  v2容器exit0，v1exit1均停止；生产454/280/21不变，无生产写入。public route handler组件验收，不称shipped Hono HTTP或durable judge_run重试验收。
  证据private judging887-actual-v2.json SHA f08c1c94f5e0b869a212ac5b899282bdeba44e6bee00ff2a711b00fd0ef41731。
  root当前codex/yuk-887-remaining-actual从origin/main建并cherry-pick两981交付docs，原脏main未动。下一Ingestion/Agency仍缺；生产CoachTask有成功plan记录但subject_mix出现probability/calculus，尚不能据task success判全部Agency语义PASS。

- 981 Done：PR1365 exact8bce5f0a0a0901404cf5b395766ab29f44910abc/CI34212977772所有job绿；10:11:34Z合并main69f1b9deb3ad760ac0b457bd7d45920bdac4852c。
  10:12:50Z Mac API6367b553/worker c430a928已8bce5f0a healthy/零重启；原PG7d99236a/09:40:42Z与pgdata未变。
  新dump已恢复loom_before_981_verify，clone/live迁移零新增/7LI通过；live454event/280task/21attempt及空队列不变，无NAS/tunnel。
  live health200/无token401/notes200(7条)，真实browser笔记读取/刷新无pageerror；首probe错CSS selector超时已纠正，不是产品故障。
  runtime-981-image.override.yml生效；回滚去该overlay回93df0528。四个隔离canary容器已终止，原失败DB/证据未动。
  root当前981-delivery-notes仅交付记录；下一887剩余learner judging/Ingestion/Agency actual证据，新$3池余$2；982/980/977 P2不混入。

- 981修后8bce5f0a actual PASS：新DB loom_notes_981_actual_v2，image1316441c；accept137→generate真实成功→ready137→verify真实成功，artifact br1jomjdbpj3pq4zvj0h49p0 ready/verified。
  同generate physical job 2e81df0b-f967-50ae-ad34-38dfa8ec855e另进程重投completed，0model/task增量；显式boss.fail加速expiry，非自动完整过期窗。
  generation1066in/3505out，verify5216in/984out，estimate合计$0.00663810非账单；新$3池保守预留$1余$2，旧reserve不回收。
  当前生产93df0528；本轮最新生产基线454event/280task/21attempt，验收前后不变，不沿用昨日424/258/4；空活动队列。
  scoped73unit/20generateDB/gates/架构/browser过；唯一验证审结束，UI无P0/P1，三引用P1已4DB RED→GREEN修复，禁第三审。
  PR1365 exact8bce5f0a CI34212977772仍余DB；未merge/deploy。root切delivery-notes存交付记录，不重启PR CI。
  新982 P2 Backlog：ADR保留check自解释，但现有UI墓碑隐藏正文；不改五kind契约、不恢复embedded quiz、不冒充完整产品体验PASS。

- owner本轮明确「批准」：Notes七文件富编辑及新增最多$3实际验收获授权，981/887恢复In Progress；新预算尚未使用，旧reserve不回收。
  981 PR1365 Draft/exact95cf627ddc21ed06237681e5f532024c295541ab；引用P1修复已推，UI P1仍未修。
  CI34151841019 exact95cf627d已终态全绿；正式初审已用，唯一验证审保留至两P1都修完。
  执行顺序：富编辑保结构→scoped gates/唯一验证审→新exact CI及真实Notes验收→Mac交付，再补887差集。
  root已切回codex/yuk-981-note-generation-contract并ff纳入handoff，无用户改动覆盖。
  生产仍93df0528，未部署981、未新增paid。新canary必须fresh DB/容器/证据名，不重烧旧失败任务。

- Active981：root独占codex/yuk-981-note-generation-contract（base395d5d2d交付记录）；生产仍979/93df0528。
  PR1365初审FAIL 2P1：富编辑丢结构（既有withText，真实组件RED）；引用无目标/无校验已本地修。
  新UI预检docs/design/2026-09-08-notes-rich-edit-preflight.md（7文件）等待批准；不得套用旧Copilot授权。
  code mirror保留；当前真实引用目录12artifact/每个8block，17generateDB与115unit/typecheck/lint/build过。
  初CI34150838539 exacted63127bc两旧Notes prompt断言失败，其余包括双DBshard通过；断言已按新契约修正。
  初审已用，唯一P0/P1验证审留待两项都修好；未开始验证审，不再发起初审。
  clean ed63127b image f13c6850已build（SDK下载重试后成功），不含后续引用修复/未部署；所有本地exec终止。
  Notes实际accept→SIGKILL137→新process recoverNoteHandoffs/physical generate成功；生成HTTP200/end_turn却输出坏JSON。
  task bymy8ayqi4gq7q7tvizfk2ep，768input/2894output，estimate0.00285186非账单；artifact rcz6xs92e1rzjdui5em1o0uw failed。
  未到ready/verify；完整Notes恢复未通过。isolated loom_notes_887_actual_v1保留，accept/generate容器已停止，无生产写入。
  单次调用保守$1预留不回收，转用$3专项余0；已问追加最多$3用于修后Notes及其它actual，答复前不再paid。
  981已Linear In Progress；用codebase-design核对ADR0020/0022，去重复正文但保留完整block tree/links/semantic能力。
  architect咨询完成：仅omit source会令现役reader/editor空白，真实blockText RED后改server派生mirror GREEN。
  compact PM保留富结构；server补ID/trust/source镜像、未知节点fail，旧sections生成退场；12unit/typecheck过。
  初版59DB（含rich-body/backlink）/12unit/typecheck/lint/build/audit过；新门状态以上方为准，生产未部署981。
  详见docs/planning/2026-09-08-notes-generation-acceptance.md；887保持In Progress，980/977 P2仍deferred。

- 979 Done：PR1364 exact32d0effbb6c6f5496101899fe7ec0c013dec2c6b，CI34147920619全部job成功。
  17:44:51Z main61421a4e6d61e0ad96c26c158a68956708f745ad；63unit/20DB/typecheck/lint/build/audits过，独立初审PASS。
  固定Mem0 3.0.13双export补丁恢复失败/strictschema、PGVector原子写；无依赖升级，Docker frozen install通过。
  17:45Z Mac app7c48b323/worker a2dacf9a均93df0528 healthy零重启；原PG7d99236a/09:40:42Z与volume不变。
  migrate零新增/7LI/legacy guard clear；424event/258task/4attempt、空活动队列不变；health200/未认证401/认证200。
  完整shipped worker免费错误场景failed attempt/无completion PASS。启动早期stop137、ready后stop0另登记980 Backlog P2。
  887 Memory v3真实GLM5.2+DashScope完成2记忆后SIGKILL137，新进程同physical job重投完成、lookup复用、0新增HTTP。
  source canary_887_memory_crash_20260908_v3，DB loom_memory_887_actual_v3；组件handler bundle，不称full worker/自动1h过期。
  v2失败保守$1+v3通过$1，转用$3专项余$1；旧$10不回收。所有canary进程停止，无NAS/tunnel。
  root独占codex/yuk-979-delivery-notes（从origin/main建）；下一条887 Notes及其它actual差集，整体goal active。
  详见docs/planning/2026-09-08-memory-failure-truth.md；原脏main没有遗留新增文件或修改。

- 951旧mailbox执行已交付：PR1363 exact57a7bbee6a1b193de912abbee94093e3e54fd5de，CI34144766869全job绿。
  16:57:40Z merge main3c8d5c1b35c10c323e3a3f55dcb294653ad29af1；初审PASS，独立12DB/54unit，无第二审。
  root121DB/82census-unit/35doc-unit/typecheck/lint/build/audits过；初CI仅历史schema分类/过时Task文档失败，已修。
  16:58Z Mac appac3e09f4/worker faa93c5f均106ac7ff healthy/零重启；原PG7d99236a/09:40:42Z不变。
  旧app/worker正常exit0，旧reconcile cron已精确unschedule/空队列；live migrate零新增/7LI就绪/新guard过。
  423event/258task/4attempt/0child/0continuation不变，APIhealth200/未认证401/认证200，browser刷新重开无错误。
  candidate image7c08b3c116ae8d049feb4e89adfcc218f8b66c137c573f7a6d2505a73705ee93；runtime-951-image.override.yml。
  回退去掉951overlay返回582b2e66；旧worker会恢复cron，下次升级须重复排空门；无历史数据/queue删除。
  owner最新「批准」承接待答问题：未用$3历史恢复专项转Notes/Memory真实恢复，上限$3；本轮未调用付费模型。
  root独占codex/yuk-951-mailbox-delivery-notes；下一线887 actual缺项，951B3术语决策仍开放；goal active。
- Active887证据差集：root独占codex/yuk-887-rollout-evidence-gap；未改产品代码，main/runtime仍978。
  七项rollout逐项区分现有actual/DB/真实process与缺口，docs/planning/2026-09-07-rollout-evidence-gap.md。
  实际Agent SDK0.3.220 + MCP1.29 Client/linked InMemoryTransport调用2test-only工具通过，真实clone DB/log/mirror。
  task canary_887_real_mcp_20260907_v2；valid嵌套长文/0.75/null成功，invalid score string被schema拒绝并failure mirror。
  clone loom_native_978_ba4bc7fe_verify模型task/attempt仍0；不是生产/paid/networktransport验收，未关闭887。
  初始probe误读output envelope失败，修断言后PASS；.tmp/yuk887-bridge-canary.cjs可复核，不引入长期harness。
  已问是否转用未用$3历史恢复专项为Notes/Memory实际恢复，答复前不付费；下一步按capability核actual差集。
  isolated shipped API582b2e66/port18887提案canary已过：draft不写node，未认证401，accept/dismiss/retract201，重复200同event。
  accepted node t6aq0h0m4eo7cboxi45lg9mj撤回后归档不删行；0task/attempt，生产423/258/4未增。
  临时tlp-proposal-887-582b2e66已stop；API-only无worker/provider keys，不称UI点击/模型生成或所有proposal kinds全验收。
  生产4provider_attempt都是8月15–16旧DashScope embedding，不能算当前矩阵通过；951完整窗口仍待证。

- YUK978 Done：PR1362 exact582b2e66cdd7f809e1f3c1509d60f668a46e9668，CI34139494605全job成功。
  15:45:36Z合并main2351d5657ec7696bf5da88226d0e33fa873bc405；初审+唯一P1验证PASS，无第三审。
  SDK后Stop父cancelled/子lost真实public worker RED→GREEN；SDK只排空/禁不完整cursor，父commit后收口。
  102DB/18unit/typecheck/lint/build/437/0/47架构门过；独立验证7DB过。旧lease恢复不猜native死、不重烧模型。
  cleanimage349a23af79dbf5a8da127e45fdc781cb22532c26cbd686697c4131824c0bbbac物理reconcile三类父终态+重复过。
  clone loom_native_978_ba4bc7fe_verify仅synthetic；新3settled/0continuation/0task/0attempt，两个candidate worker均exit0。
  15:46Z Mac app25df8e2f/worker e0479148均582b2e66 healthy/零重启；原PG7d99236a/09:40:42Z/pgdata未变。
  原app/worker stop均0，live migrate零新增、7LI readiness过；423event/258task/4attempt/0child与空队列不变。
  health200/未认证401/认证200/sessions200；browser抽屉刷新重开无pageerror，截图private copilot-after-978.png。
  runtime-978-image.override.yml已生效；去掉overlay可回appc6bbf5e1/worker14ea1a81。无NAS/tunnel/paid/数据删除。
  root独占codex/yuk-978-delivery-notes，原脏main不动；旧$10safe0.04177，专项恢复$3未用。
  下一单887只做7条rollout验收证据差集，再补必要缺项；951完整drain窗与977 P2独立，不新增全仓清理。
  887 rollout不等于implementation gate；不能靠mock关闭生产证据，也不能为旧验收要求重建已退休provider路径。

- 951 source-only部分已交付：PR1361 exactab0bbb909aca47530f706b2204045f6cd4b12a12，CI34134547233全job绿。
  2026-09-07T14:54:05Z merge main26e0e2d6550404bdfeaee22df38a56dc56ff140c；独立初审PASS，无finding/无需第二审。
  独立2文件8unit过；root31unit/41DB/typecheck/lint/build/audits过；生产无live import差异，不为此重启。
  951仍Backlog（未完成drain/noun retirement）；未改table/handler/native投影/reader/cancel，无paid/生产写入。
  978新Todo：原生child无terminal时父退出可留running，root与explorer静态核实且真实PG公共owner RED。
  isolated clone loom_before_973_verify内start→stream抛synthetic_root_transport_failure→recover返回三个空数组。
  child仍running/lease=null/settled=null，continuation0；sentinel rollback后probe_rows/probe_events均0。
  临时probe文件已移除，首次误写events.ts导入失败不算有效证据；有效输出已记Linear978。
  下一条978正式scoped DB RED→parent权威outcome/late-start与late-terminal fence→review/CI；不猜死/不重烧/不mint continuation。
  root当前codex/yuk-951-delivery-notes，原脏main不动；gh CI watcher3383/merge54999均exit0，无probe进程。

- 951 source-only实施历史：base976交付记录3f3314ac。
  删除7个unregistered模型control适配器（两文件），无production import，仅旧unit与exists断言消费。
  删除重复存在性case和四死tool mirror断言；保留manifest排除/权限、native prompt/config与真实drain行为测试。
  未改mailbox/kernel/handler/schema/native projection/reader/cancel，不能将dead adapter当恢复接口。
  31unit/41真实mailbox与tooloperations DB/typecheck/lint/build及架构门过；初审/CI已按上方完成。
  14:39:26Z生产三表全空，无legacy run/continuation/DLQ；reconcile completed274，最早10:06:50Z。
  queue agent实际expire7200/retry2/delay30/backoff，完整窗口未证明；951保持开放，不撤drain handler。
  docs/planning/2026-09-07-legacy-control-retirement.md记录边界；无生产写入/paid，整体goal active。

- YUK976 Done：PR1360 exactc6bbf5e18d121e9da0f694baffc5a0cafe528ea3，CI34132735074全job success。
  2026-09-07T14:35:12Z合并main722b352b09a1e628ae003a36eadf14a2fee18dac；初审PASS，独立5unit/10browser过。
  advisory P2 known-zero来源省略已核实、查重登记977 Todo，回复deferred-not-fixed并resolve，无第二审。
  Mac14:35:29Z仅app部署c6bbf5e1，image0e7c1a0de9af98ca515b5a8bcd4caacfbb3c784378af3b774057595412b61a8d。
  app5a4d3f1d healthy/零重启；worker7dc3538e仍14ea1a81/StartedAt13:48:05Z，PG7d99236a/09:40:42Z未变。
  原pgdata保留，未执行迁移；event423/task258/attempt4与零active/created/retry不变，无paid/NAS/tunnel。
  health200/未认证401/认证200，cost两API200；实际Admin7day rows展示来源与unknown，Today真空态。
  两页真实390px browser无溢出/pageerror；production mobile截图已目检，证据cost-976-production-mobile.png。
  runtime-976-app.override.yml只覆盖app，回退去掉该overlay回到975 app；无需重启worker/PG。
  临时host PID59988已确认停止，不得重复signal；cleanimage容器tlp-cost-ui-c6bbf5e1已停并移除，无volume删除。
  root独占codex/yuk-976-delivery-notes，原脏main未动；恢复专项$3未用，旧$10safe0.04177不回收reserve。
  976已交付；977零来源、951完整重试窗drain、887完整provider/crash矩阵仍开放，整体goal active。

- 976实施历史（由上方交付状态取代）：owner已明确「批准」六文件UI预检；base5e6562917。
  951仅曾读取issue/指引，未开实施/未操作数据；收到批准后已暂停，只有976一条写入线。
  Today/admin复用ApiOperationJsonResponse与describeCosts，删除两窄类型/重复金额格式；unknown-only不显示0。
  mixed显示已知小计+未知与reported/estimated/legacy细目；加载/错误不伪造金额，零值与空态分开。
  15helper/Today unit、10新shipped-browser用例通过（两页desktop/mobile及四费用状态+error/loading）。
  18原cost API/reader DB已过；无backend/provider/ledger改动，保留现有查询重试与权限。
  mobile Admin旧intrinsic header宽度已本页约束；未改全局CSS，两张390px截图已目检，金额无裁剪。
  private证据目录cost-976-admin-mobile.png/cost-976-today-mobile.png；浏览器用无provider凭据isolated API。
  当时测试API port18787，cwd tlp-cost-ui-976.wpuLuc，DBloom_before_973_verify；现已停止。
  final gates/初审/exactCI/本地交付已按上方完成；无paid，恢复专项$3未用。

- YUK976批准前只读记录（现由上方实施状态取代）：main5e656291/f376c6aa，当时未改UI代码。
  server provider-cost-projection/cost-today/admin-cost truth字段完整；18相关API/reader DB全过。
  两真实consumer（TodayPage CostRibbon、admin-cost）手写窄类型丢reported/estimated/legacy/unknown。
  shipped14ea1a81浏览器拦截仅admincost GET，合法unknown USD+8912in/731out/1call，$0.0000可见，无unknown提示。
  两次早期浏览器定位超时是精确文案遗漏「 · USD」，不是产品错误；修正locator后反例已实际捕获。
  live今日cost API为空，不称生产unknown canary；没有生产writes/paid，专项恢复$3仍未用。
  已查重并创建976（841/844/964均已Done）；UI预检docs/design/2026-09-07-cost-truth-preflight.md列精确6文件。
  拟复用src/ui/lib/api.ts的ApiOperationJsonResponse/生成契约，替换两手写窄类型；纯共享展示helper与shipped browser验证。
  等待这两个page surface批准，旧授权只覆盖Copilot drawer；允许继续独立全产品扩展成本核对。
  不为UI批准等待将整个goal blocked；生产仍975/14ea1a81，root保持单writer，原脏main未动。

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
