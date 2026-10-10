# PLAN — 活看板

> Linear 是权威 tracker。2026-10-10 17:10 JST：YUK-1388 第四批审查完成，最终报告见 `tlp-audit-artifacts/yuk1388/stage4/final-report.md`；功能波次 W0–W4 已登记 YUK-1404–1445（W0 优先 1404/1405/1445/981）。YUK-1402/1401 Done；YUK-1403 剩 32 个 migration-smoke 用例等 #1625。迁移线 run11 恢复重开状态见 NOW 的 YUK-1359。

## NOW

- **YUK-1388 / 第四批审查完成（2026-10-10）**：O1–O7 裁决、7 个 P0 根（含新增 M100 出题前自动可判 → YUK-1445）、100 根 / 828 子主张、W0–W4 五波，见最终报告 `tlp-audit-artifacts/yuk1388/stage4/final-report.md`（仓库外 artifact 目录）。V01/V02 独立审查 15 条发现全部接受并由 I03 修正。票保持 In Progress，等 owner 读报告并裁决是否清理 R03 写入 TEST Mem0 的 5 条合成危机记忆。
- **YUK-1403 / 测试第二轮清理**：#1635（Rust parity 进 CI Gate、残留引用、unused 36→0）与 #1636（26 例）已合 main；剩 `tests/integration/migration-smoke.test.ts` 32 例/1093 行等 #1625 合并后删，依据 `tlp-audit-artifacts/yuk1388/yuk1403/case-inventory.jsonl`。

- **YUK-1358 / Start notes列表**：独占范围和验收见[notes计划](docs/planning/2026-10-09-yuk1358-start-notes-list.md)。保留查询校验、科目知识点解析、空集合语义及现有搜索/导航/视觉；不改note详情/presence/AI写，不把本切片当Notes整族完成。父50unit/18DB、R1 NONE和49RPC/原页面浏览器通过；98表/5序列窗口不变，PR1626已合main04232aaf10（exact9889 CI全绿）；父已fetch核main；[父证据](docs/planning/2026-10-09-yuk1358-start-notes-list-parent.md)。useSubjects仍HTTP，完整迁移未完成。

- **YUK-1359 / 恢复后重开验收**：run11固定helper b52e/worker7472真实capture→完整restore parity→同一target身份→prelaunch→DBOS reopen通过，见[父报告](docs/planning/2026-10-10-yuk1359-restore-parent-acceptance.md)。pending1→3恰好2新效果/receipt，completed/unknown与source rawseal不变；4schema/123表/5序列完整对等。父1045分层offline、3029source/3076evidence绑定通过；不外推judge/provider/全家族。源/恢复端停止保留，19:04:18Z核owner/原4/running/release后释放锁。run01–10失败保留不得重启；无运行锁/worker或代码writer，最终194unit/static/build/10audits通过，PR1628已开/link，等待exactCI。

- **YUK-1359 / 完整恢复证明**：四现有helper/receipt类型+scopedtests/runbook范围已实施。独立R1 scratch TCP认证P1由887012/R2 NONE解决；后续array v2差异由父194unit/14真实DB与run11全量恢复证据覆盖，不冒称R2覆盖后续delta、不启R3。完整helper源码和runbook留本分支，父194unit/typecheck/lint/build及10postbuild audits全过，已开PR1628并link，exactCI待完成，不将helper交付等同YUK1359整票完成。

- **YUK-1358 / Start事件详情与纠错**：PR1623已完成15DB、R2 NONE及4f36真实71RPC/T3浏览器验收，证据封存；正常整合96077db19仅PLAN/now冲突，20个本lane产品/测试文件与已验head一致。整合193unit/11协议及全部静态构建审计通过，已于22:52Z合main7472f4395（exact91f468 CI全绿），详见[父验收](docs/planning/2026-10-09-yuk1358-start-event-detail-parent.md)。旧4f36首因不倒推，未部署。

- **YUK-1394已合入**：PR1624于22:32:03Z合main96077db19，与exacta880树一致，CI37852269707全绿；共享锁父29DB/确定性RED/34进程及排期32unit/static/build证据按revision保留。原R2两finding解决，后续修复不冒称R2覆盖，无R3；默认pg-boss、无部署。详见[父验收](docs/planning/2026-10-09-yuk1394-parent-acceptance.md)。
- **YUK-1393已合入**：PR1621 exact3be966000 CI37829575046全绿，R1 NONE/threads0；main e1f2ef6bb与CI树均cad230a5，已unwatch/Linear Done。父原33DB/10进程恢复/2cron/4旧prune/26migration、49unit及fixture修复29DB/static/build证据保留。默认仍pg-boss，无部署；实际旧consumer退出仍是整迁移验收义务。
- **YUK-1358 / Start观察读取已合入**：PR1622已合main6212a4560，exact0fbeb1f3f CI37831807097全绿、R1 NONE；26真实RPC/10窗口、T3浏览器和88表/序列无写证据见[父验收](docs/planning/2026-10-09-yuk1358-start-agent-notes-parent.md)。28路由中13显式Start（含root redirect）/15 fallback，仅静态覆盖计数；完整迁移与canonical boot未完成。5796接续events/$id，未合候选不提前计入。
- **YUK-1358 / Start配置与科目消费者已合入**：PR1620于18:16:17Z合main10df1a471，tree与exact755bdeebb一致，CI37821989407全绿/R1 NONE/threads0。18操作122RPC/35窗口与三页浏览器证据见[父验收](docs/planning/2026-10-09-yuk1358-start-admin-controls-parent.md)。未部署；1358保持In Progress。5796独占接续1392 board、剩余Start路由和实际提交，本线程不写其活跃树。
- **YUK-1359 / 整体退出证据**：7631对用户负责迁移协调和最终交付，维护W1–W5消费者清单。当前已交前门、错题、Today/Inbox主读取和五管理只读页；嵌套HTTP消费者、其余路由、任务族、旧SPA/pg-boss退出尚未齐备。按[退出清单](docs/planning/2026-10-07-yuk1359-exit-inventory.md)逐项验收，不能把公共出口或源码slice当整页完成。
- **YUK-1356 / 复习竖切未完**：PR1605共享review操作/可信Pi原件入口及单次MiMo效果证据有效，但Start提交与判分DBOS族仍缺。17:02Z后直接读回Linear已恢复In Progress；未启动重复writer，不宣称judge_run已迁移。
- **本轮已交付 YUK-1392**：PR1619于17:11:43Z合main6aaf8ca89，tree5e8ab973与exact3883903相同；CI37812973662全绿、R1 NONE、threads0。父13unit/22DB、static/build/audits通过，已unwatch/Linear Done。无部署。

## NEXT

- Start/judge共享文件边界见[交接](docs/planning/2026-10-09-judge-start-ownership.md)，Start/boot/shutdown由5796独占；judge A/B/C/D由7631接续，迁移号后核。

- 1394已正式交付，7631从fresh main沿既有YUK1356接judge_run与judge_pending_reconcile同族。5796已确认A/B/C/D精确scope无其writer冲突，Start/boot/shutdown仍归5796；迁移号届时核实。设计与ownership不是实施验收。

- 1355已交prune_job_events与review orphan源码及隔离证据；1394接续两个session族。其他业务任务不能据此视为已分派或已迁移；每族须保留唯一恢复owner、旧义务排空与回退证据。
- 1358继续剩余路由/共享子树及三入口共用业务操作，保留现有确定性行为。1392公共board读取、1380事件读/纠错等已合接口由Start集成方接消费者，不复制领域规则。
- 1359最终收口核对dev/build/Compose/镜像、全部旧消费者、任务/worker/依赖、配置与文档；Hono去留按ADR裁决，旧SPA回落不得永久保留。完成整迁移后再按实际缺口与查重结果交付Linear残留功能。
- UI按owner新排期并入迁移后的功能波次：后端先交付、Opus5.5再改渲染；迁移期间保留旧视觉。1354仅隔离基座/展示组件可先行，展示路由仍5796挂载；同Start路由组件回退不保留旧SPA。完整协商及已有UI观察交接见[排期边界](docs/planning/2026-10-09-ui-migration-sequencing.md)。
- **功能波次 W0（Urgent）**：后端 YUK-1404 照片导入、1405 定位与冷启动备题、1445 出题前自动可判、981 笔记解析交付、1407 判分语义、1408 隐私用途、1409 长任务业务回执、1398 危机；UI YUK-1438（Opus 5.5 only）。W0 出口含空库首日脚本旅程（墙钟上限 + 确定性兜底）、自动可判 ≥80%、KC 不自动批准、5 项摩擦指标；数值为建议默认值待 owner 确认。触及 §9 承重能力的删减须 owner 明确批准。
- UI 线：视觉方向已定（#1612、#1627）。#1633 KaTeX、#1634 F06 对比度与 #1642 ≠ 修复（YUK-1446）已于 2026-10-10 20:01 JST 部署到 TEST（main `515669863`），并完成真实页面截图验收。遗留 YUK-1447（等 rehype-katex 升级）。下一步 YUK-1438：等功能线各后端片落地后接入；placement/profile 的 UI 等迁移线给出 Start client 契约。

## PARKED

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

- **owner 裁决**：W0 出口数值；TEST Mem0 中 5 条合成危机记忆是否清理（YUK-1388 关单条件）。

- 迁移线当前没有需要owner追加许可才能推进的已知阻塞。1393已合入，1394进入父级验收；子任务/CI仍运行属于等待，不把整迁移挂blocked。
- runtime测试/发布在执行前必须实际核锁并原子获取，核owner/token清理释放；其他线程持锁时只推不冲突的源码工作。历史锁记录不能代表当前ownership。
- 部署用途保持Agent开发测试，禁止再次清库、恢复私人数据或盲重放队列；日用部署须owner明确要求“为我日常使用的部署”。旧运行验收限制和未完成产品能力保存在归档及各原票，未被本次整理核销。
