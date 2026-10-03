# PLAN — 活看板

> 更新于2026-10-03。Linear 已恢复。当前交付链为 YUK-1111 schema gate → YUK-1112 pi 1.0.0 升级 → YUK-1007 locale PR #1521 收口。本轮不部署、不新增付费评测；每个 PR 仍须独立审阅、exact-head CI 和最后 push 后约17分钟。

## NOW

- YUK-1115：同PR补齐共享依赖gate：Axios升至1.20.0、移除Mem0误列的Jest测试类型peer及Braces链。51 Mem0 unit、typecheck/lint/build和生产依赖审计通过（0 high/critical，18 low/moderate仍在）；待远端CI。
- YUK-1111：复核65条到期schema豁免，移除61条已有生产依据的例外；新增direct raw SQL与DB生成值识别。4个真预留字段单独跟进YUK-1113（10月10日复核）；旧scanner将fixture计入writer的问题见YUK-1114。尚待本PR验证与合并，详见 `docs/planning/2026-10-03-yuk1111-schema-producers.md`。

- #1512保留DB4/unit4、19项审计并行、单次构建、tmpfs、时长统计与SDK懒加载。五个predicate用例已恢复，共11个。局部87 unit、先前67 DB、typecheck、lint、build通过。排序修复后的 `619ac1602` 完整CI `36729120083` 全绿，事件是workflow_dispatch，四个unit和四个DB分片、审计、migration、build/usability均实际运行。详见 `docs/planning/2026-09-30-yuk1107-ci-latency.md`。YUK-1107不标Done。
- #1501修复D18三个P1。未知费用使用非空保守预留，失败调用记费用，typed runner尊重caller的 `retry:none`，seal写入错误不重发模型。`de2c7911c` 修复后55 unit与6 DB通过，同步main后的 `3b7036b06` 再验55 unit、6 DB、typecheck、lint与build通过，PR gate `36728701979` 全绿。已有Jev实跑属于历史证据，本轮没有重新付费，也没有完成MiMo评测。
- #1504已squash合入main `30f6691fd`，exact-head gate `36723337522` 全绿。它修复typed override/global pin假报告与被丢弃vision model的effective值。真实隔离API返回无token401、有token200、typed global pin为null、provider/model/budget override均false、vision effective为null。局部43 unit与20 DB通过；同步依赖后的 `cfea12ade` 再验20 DB和真实API通过。YUK-1106候选按created_at、dispatch_seq、id排序，原15项和反向物理插入4项DB回归全绿，不以同SHA rerun-green代替修复。
- #1320、#1405、#1507分别收下Rust cache action、pnpm action与dotenv18更新，不扩大到pnpm12。#1505、#1506、#1508未满足兼容和验证条件，关闭而不合入，保留远端分支和以下待办。
- #1499、#1509、#1513的漂移报告纠正SDK→pi被误判为违规的结论，保留其余发现。不将没有逐项证据的Aligned数当作验收。三份报告保留，待办归并，不丢弃有效发现来减少PR数量。
- 09-28生产切换记录是历史证据，见 `docs/runbooks/2026-09-27-assessment-cutover.md` §0–6。记录为 `assessment-contract-v1/active` seq7、镜像 `e03686e9f`、19条identity mapping。#1502修复旧端口与epoch status CLI。它不代表本轮部署或重新查验生产。
- #1498热加载foundation的六个P1已随main `30353105d` 修复。#1504只交付读取端点、providers/schedules/runtime与configured/effective说明。YUK-1007 epic仍未完成。
- YUK-1038的17主线票和10矫正票交付记录仍保留于cutover runbook、各PR与旧版看板。旧NOW叙事归档到本机 `.remember/2026-09-30-plan-before-closeout-merge.md`，该文件保留本次合并前的原文，含当时冲突块；不是当前操作指引。

## NEXT

1. 回到产品主线。YUK-1007下一步仍需确认预算和语言reader迁移、配置写面与面板UI的实施范围；UI preflight未批准，不自行开工。
2. YUK-1105 revision-registry producer与pending映射回放保留Backlog，首次产物审核放行方式待owner裁决。
3. YUK-1103 autonomous-product-loop保持挂起，YUK-1101保持Backlog，不因本轮清PR自动启动。

## PARKED

- Linear 已恢复；YUK-1106已同步Done，YUK-1107暂停/Backlog，YUK-1007仍In Progress。历史待办继续逐项核验、去重后同步。
- YUK-1112已获owner明确升级授权，目标registry最新稳定1.0.0。此前#1508的pi0.87.1已移除 `shouldStopAfterTurn`。必须迁移parent/subagent至 `finishTurn`，验证最大turn、tool loop、错误/abort分支的wire计数，不用类型断言掩盖。原分支保留，不是已完成的迁移。
- #1506的jsdom30要求Node24.15+，仓库pin24.0.0。必须协调运行时与DOM回归。#1505的Biome2.5.14原CI有1error、375warnings，超过305基线。必须修真实diagnostics并证明计数，不抬基线放行。原分支保留。
- 漂移待办归并一组。同步ADR-0003/0004及0054–0060的SDK→pi机制与0054状态记录；保留产品决策，不恢复SDK、不先宣称全部行为等价。另核对agency/notes manifest概要、根AGENTS的 `/api/ready` token豁免说明、无consumer的 `SKIP_BOSS_INGEST` 声明。证据见 `docs/audit/2026-09-28-drift.md`、`2026-09-29-drift.md`、`2026-09-30-drift.md`，不建三个重复票。
- 状态同步。YUK-1106在#1504 exact-head gate与合并完成后应收口；YUK-1007仍In Progress，因为预算/语言/UI/写面未完；YUK-1107暂停且未证明120秒，不标Done。D18新付费评测待单独授权。上述状态已同步Linear。
- YUK-1106的#1512阻塞已解除。原 `278a4e936` 的CI `36725357009` 在 `assessment-verdict.db.test.ts:332` 收到j_new、预期j_old。源码diff确认它缺少#1504的候选排序，不是已修代码复发。先合#1504，再同步main，原19项DB用例和新head完整CI `36729120083` 通过。未rerun原SHA，未删断言。原日志封存 `.remember/tmp/pr-closeout-20260930/1512-shard4.log`；Linear恢复后归并原票，不开重复票。
- YUK-1007读面仍有四项已裁决P2，不在本轮扩面。`providers[].implemented` 未表达typed-task限定的OpenRouter实现；schedules遗漏 `event_subscription_dispatch`；vision对非OAuth错误provider/缺key的effective报告仍偏乐观；tasks的global_pin未标无效provider名。#1504评论4133649105、4133649102、4133649097、4133645669已给跳过理由。合并到原epic跟进，不将providers/schedules读面称为完备，不新建四个重复票。
- YUK-1045历史待办仍保留。claim冲突路由未翻译409 `claim_conflict`；source_verify child→root锁序与publisher反向；`publishQuestionGroup` 未调 `validateStructure`。实施前核对当前代码和远端票，不把历史发现当作新回归。
- Astra P2/P3仍叫停。YUK-1028 Backlog，YUK-1029 needs-info。921多provider、572夜间教研、832 HOLD不解锁。全历史ADR审计没有完成。951按ADR0063保留的历史表、native投影与live remote ToolOperations不做通用表名合并。
- #1504 startup RED已修。根因是unit没有mock新增hydrate边界，造成真实DB读取及动态导入越过teardown。阻塞hydrate、释放前recover/serve=0、释放后各1的回归与完整startup文件已通过，不另建已解决的重复票。

## BLOCKED-ON

- 本轮明确不部署。Mac/NAS生产数据库、容器、flags与provider凭据不动。新paid评测仍需独立授权；pi 1.0.0依赖与执行接口迁移已获本轮明确授权，不含生产部署。
- 各交付PR须独立review、真实required check与最后push后约17分钟等待窗。本看板最后合并，不能用文档先称业务PR已落main。
- 原始脏工作树不动。实施和交付使用独立工作树，所有未合入分支保留。不删计费、重试、复杂parser、并发/回滚/恢复、UI安全测试来凑计数。
