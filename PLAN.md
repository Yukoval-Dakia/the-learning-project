# PLAN — 活看板

> 更新于2026-09-30。本轮先收口现有PR，再回产品主线。本看板须在#1512、#1501、#1504合并后入main，交付状态以各PR的squash记录为准。已有CI提速保留，后续优化暂停，120秒未证明。本轮不部署、不新增付费评测。Linear connector不可用，待同步项先存PARKED，不声称已更新Linear。

## NOW

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

- Linear capture暂存。当前connector catalog无Linear工具，无法查询远端重复票或更新状态。以下已按本地报告和原票去重；恢复后先查远端重复，再更新原票或归并立票，不把暂存当作完成。
- #1508的pi0.87.1已移除 `shouldStopAfterTurn`。必须迁移parent/subagent至 `finishTurn`，验证最大turn、tool loop、错误/abort分支的wire计数，不用类型断言掩盖。原分支保留，不是已完成的迁移。
- #1506的jsdom30要求Node24.15+，仓库pin24.0.0。必须协调运行时与DOM回归。#1505的Biome2.5.14原CI有1error、375warnings，超过305基线。必须修真实diagnostics并证明计数，不抬基线放行。原分支保留。
- 漂移待办归并一组。同步ADR-0003/0004及0054–0060的SDK→pi机制与0054状态记录；保留产品决策，不恢复SDK、不先宣称全部行为等价。另核对agency/notes manifest概要、根AGENTS的 `/api/ready` token豁免说明、无consumer的 `SKIP_BOSS_INGEST` 声明。证据见 `docs/audit/2026-09-28-drift.md`、`2026-09-29-drift.md`、`2026-09-30-drift.md`，不建三个重复票。
- 状态同步。YUK-1106在#1504 exact-head gate与合并完成后应收口；YUK-1007仍In Progress，因为预算/语言/UI/写面未完；YUK-1107暂停且未证明120秒，不标Done。D18新付费评测待单独授权。当前未向Linear写入这些状态。
- YUK-1106的#1512阻塞已解除。原 `278a4e936` 的CI `36725357009` 在 `assessment-verdict.db.test.ts:332` 收到j_new、预期j_old。源码diff确认它缺少#1504的候选排序，不是已修代码复发。先合#1504，再同步main，原19项DB用例和新head完整CI `36729120083` 通过。未rerun原SHA，未删断言。原日志封存 `.remember/tmp/pr-closeout-20260930/1512-shard4.log`；Linear恢复后归并原票，不开重复票。
- YUK-1007读面仍有四项已裁决P2，不在本轮扩面。`providers[].implemented` 未表达typed-task限定的OpenRouter实现；schedules遗漏 `event_subscription_dispatch`；vision对非OAuth错误provider/缺key的effective报告仍偏乐观；tasks的global_pin未标无效provider名。#1504评论4133649105、4133649102、4133649097、4133645669已给跳过理由。合并到原epic跟进，不将providers/schedules读面称为完备，不新建四个重复票。
- YUK-1045历史待办仍保留。claim冲突路由未翻译409 `claim_conflict`；source_verify child→root锁序与publisher反向；`publishQuestionGroup` 未调 `validateStructure`。实施前核对当前代码和远端票，不把历史发现当作新回归。
- Astra P2/P3仍叫停。YUK-1028 Backlog，YUK-1029 needs-info。921多provider、572夜间教研、832 HOLD不解锁。全历史ADR审计没有完成。951按ADR0063保留的历史表、native投影与live remote ToolOperations不做通用表名合并。
- #1504 startup RED已修。根因是unit没有mock新增hydrate边界，造成真实DB读取及动态导入越过teardown。阻塞hydrate、释放前recover/serve=0、释放后各1的回归与完整startup文件已通过，不另建已解决的重复票。

## BLOCKED-ON

- 本轮明确不部署。Mac/NAS生产数据库、容器、flags与provider凭据不动。新paid评测与运行时迁移均需独立授权。
- 各交付PR须独立review、真实required check与最后push后约17分钟等待窗。本看板最后合并，不能用文档先称业务PR已落main。
- 原始脏工作树不动。实施和交付使用独立工作树，所有未合入分支保留。不删计费、重试、复杂parser、并发/回滚/恢复、UI安全测试来凑计数。
