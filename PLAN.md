# PLAN — 活看板

> Linear 是权威 tracker。2026-10-09 JST：judge71bd修复已交，原回执DB严格用例通过；后续reconcile暴露null因果字段schema边界不一致。唯一writer修该族schema；01:05:25Z锁安全释放，原4/release未变。R2及完整验收仍待，整迁移In Progress。

## NOW

- **YUK-1358 / Start事件已合入**：PR1623于22:52:00Z合main7472f4395，exact91f4687ed CI37854525406全绿、R2 NONE/threads0；5796已unwatch。15DB/71RPC/T3浏览器及193unit/11协议/static/build/audits按revision保留，见[父验收](docs/planning/2026-10-09-yuk1358-start-event-detail-parent.md)。本树正常整合该main；未部署。

- **YUK-1394已交付**：PR1624合main96077db1905ebab6a522b0ae36f9f22e26be5895，tree与exact a880均a8bcf299050ed76c6cbd91ac4e98d266c395bf46，CI37852269707全绿/threads0。共享锁29DB/34进程与隔离RED、排期修复32unit/static/build、旧cron/migration证据按revision保留，无R3。Linear Done；未部署，旧binary quiescence仍是运行切换要求。见[父验收](docs/planning/2026-10-09-yuk1394-parent-acceptance.md)。
- **YUK-1393已合入**：PR1621 exact3be966000 CI37829575046全绿，R1 NONE/threads0；main e1f2ef6bb与CI树均cad230a5，已unwatch/Linear Done。父原33DB/10进程恢复/2cron/4旧prune/26migration、49unit及fixture修复29DB/static/build证据保留。默认仍pg-boss，无部署；实际旧consumer退出仍是整迁移验收义务。
- **YUK-1358 / Start观察读取已合入**：PR1622已合main6212a4560，exact0fbeb1f3f CI37831807097全绿、R1 NONE；26真实RPC/10窗口、T3浏览器和88表/序列无写证据见[父验收](docs/planning/2026-10-09-yuk1358-start-agent-notes-parent.md)。28路由中13显式Start（含root redirect）/15 fallback，仅静态覆盖计数；完整迁移与canonical boot未完成。该计数为6212静态快照，events/$id已随后合入，待退出清单统一重计。
- **YUK-1358 / Start配置与科目消费者已合入**：PR1620于18:16:17Z合main10df1a471，tree与exact755bdeebb一致，CI37821989407全绿/R1 NONE/threads0。18操作122RPC/35窗口与三页浏览器证据见[父验收](docs/planning/2026-10-09-yuk1358-start-admin-controls-parent.md)。未部署；1358保持In Progress。5796独占接续1392 board、剩余Start路由和实际提交，本线程不写其活跃树。
- **YUK-1359 / 整体退出证据**：7631对用户负责迁移协调和最终交付，维护W1–W5消费者清单。当前已交前门、错题、Today/Inbox主读取和五管理只读页；嵌套HTTP消费者、其余路由、任务族、旧SPA/pg-boss退出尚未齐备。按[退出清单](docs/planning/2026-10-07-yuk1359-exit-inventory.md)逐项验收，不能把公共出口或源码slice当整页完成。
- **YUK-1356 / 复习竖切未完**：PR1605共享review操作/可信Pi原件入口及单次MiMo效果证据有效，但Start提交与判分DBOS族仍缺。17:02Z后直接读回Linear已恢复In Progress；未启动重复writer，不宣称judge_run已迁移。
- **本轮已交付 YUK-1392**：PR1619于17:11:43Z合main6aaf8ca89，tree5e8ab973与exact3883903相同；CI37812973662全绿、R1 NONE、threads0。父13unit/22DB、static/build/audits通过，已unwatch/Linear Done。无部署。

## NEXT

- YUK1356固定5f09独立R1为3项P1/0P0；回执ff694与通知/时钟71bd已交。父核11文件/884制品/18日志，原回执严格DB用例1PASS、完整lint通过。后续reconcile写入在真实parseEvent失败，唯一writer `yuk1356-operational-envelope-repair-20261009-v1` 修本族null/undefined因果边界和正负例；kernel只读。父保留后续DB/迁移/进程/消费者验收与唯一R2，不启第三审。

- 1355已交四个housekeeping族源码及隔离证据。下一idle族只读设计已交回，父核45源码+3报告；保留原userclock，5796已以13d317da8明确交接精确Copilot/session/practice写路径。未起idle writer或分配编号，judge交回后再核最终锁序。其他业务任务不能据此视为已分派或已迁移；每族须保留唯一恢复owner、旧义务排空与回退证据。
- 1358继续剩余路由/共享子树及三入口共用业务操作，保留现有确定性行为。1392公共board读取、1380事件读/纠错等已合接口由Start集成方接消费者，不复制领域规则。
- 1359最终收口核对dev/build/Compose/镜像、全部旧消费者、任务/worker/依赖、配置与文档；Hono去留按ADR裁决，旧SPA回落不得永久保留。完成整迁移后再按实际缺口与查重结果交付Linear残留功能。
- UI视觉重写暂缓；必要路由/数据接线仍是本轮迁移。UI恢复时沿owner模型限制；非UI按AGENTS选模，产品MiMo路由不因开发代理改变。

## PARKED

- **YUK-1356 judge打包阻塞**：父实读作者build-first.log:979，Start自包含打包无法解析DBOS5.2.11可选winston-transport；build-migrate.log同报winston/transport。server/worker已有两项external，Start和migrate尚未一致。5796已核77树/75可访问并明确将两文件交原judge writer：仅Start服务端及build:migrate external精确winston/winston-transport，保留其余自包含配置及依赖/lock。作者完整build已通过且产物hash父核一致；父仍须安全验证真实ESM/CJS默认logger加载、不直接执行连接库/迁移/服务入口，OTLP分支不在本证明范围。父已格式化1359证据JSON并核语义完全相同。

- **YUK-1358/1359已有UI观察**：真实Inbox dismiss后本页499但侧栏500，document reload恢复一致；原onResolve仅本地resolved更新。Google Fonts原import受CSP拦截；fallback可用。记录在现有迁移验收/后续UI边界，不放宽CSP、不冒称本PR修复。
- **YUK-1382 / Admin runs未知费用显示**：源码基线fadcb0c87中，observability/ui/admin-runs.tsx:207将nullable cost_usd累加；observability-shared.tsx:11以(value ?? 0).toFixed(4)将未知显示为$0.0000，列表/详情/合计均受影响。已查重并登记Backlog，待验证真实零、全未知、已知+未知；不在1381改UI。此条是源码发现，尚无浏览器验收。

- YUK-1355 P2 comment4208022050：cron权威目录仍将 prune 注册点写为 ../handlers.ts。最小范围为目录说明及一行注册点/phase ownership 文档；不需要新 scheduler/catalog 子系统。已报告父线程裁决，本轮未改该 P2。

- **YUK-1359临时挂载退出**：生产SPA的/mistakes改为document handoff，Vite-only dev暂留原HTTP consumer；全部路由及dev/build/镜像入口迁入Start且逐页验收后删除旧SPA回落与dev adapter。未宣称其他路由退役。


- **YUK-1360 父线程发布验收义务**：真实 startup 返回 schema44 时仍有7项 BAM index 工作 pending；不能把 start/health/Drizzle smoke 当作 background migration 完成。本 lane 验证 disposable 完成与 index validity；生产需父线程在既有发布流程核验。旧12.26.3默认启动仅证明单个 synthetic queue 操作，`migrate:false`拒绝44；没有执行或批准 queue downgrade。归入既有 YUK-1360/YUK-1329 验收，不在此 lane 新建 Linear。
- YUK-1346：源码已有单次派生用途策略，本轮保持其边界，不重开记忆修复；真实运行验收仍由其 owner 核验。
- YUK-1343：失败创建提前标为显式来源、50条历史截断隐藏可续接会话均未修；已成组登记，不阻塞此次已裁决发布。

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此前 MiMo 发布的 R2 时序补证保留。本次入口发布全部最终备份在停写后，101表计数恢复一致、63附件完整。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- YUK-1325 / PR #1580：保留 `1be38edbc`、`1af72b427`、`3940d61f9`，正常合入 main `8841ce68a` 为 `e484efa60`；359 scoped tests、21 audits、typecheck/lint/build 与 lint ratchet 通过，无 high/critical 依赖告警。开发 transcript 与产品 MiMo/自主交付指导同时保留。writer 已释放，父线程负责最终 SDK/SQL/browser 回放、push、exact-head CI、review replies、Linear 与发布；P2 typed tracing 留 YUK-1339，不启动第三审。详情见 [Laminar 记录](docs/planning/2026-10-06-yuk1325-laminar.md)。旧完成线程越界写入风险仍由父线程独占 watch 约束，平台跟进待去重登记。 最新 main 的前缀 credential P1 修复及73tests记录一并保留；PR父线程仍负责后续验收，此lane无新review。

## BLOCKED-ON

- 1393/1394均已合入。judge R1修复有唯一活动writer，不需用户重复授权。子任务/CI仍运行属于等待，不把整迁移挂blocked。
- runtime测试/发布在执行前必须实际核锁并原子获取，核owner/token清理释放；其他线程持锁时只推不冲突的源码工作。历史锁记录不能代表当前ownership。
- 部署用途保持Agent开发测试，禁止再次清库、恢复私人数据或盲重放队列；日用部署须owner明确要求“为我日常使用的部署”。旧运行验收限制和未完成产品能力保存在归档及各原票，未被本次整理核销。
