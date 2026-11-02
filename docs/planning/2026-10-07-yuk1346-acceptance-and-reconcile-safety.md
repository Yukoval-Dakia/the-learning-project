# YUK-1346 实际验收与整理重投修复

2026-10-07 原验收时记录的生产为 f3bfff2cfe2aea0efbf7d11ead8a84ebfab497ef；这是历史状态，不代表当前 runtime。最新 owner 已退休聊天审核，恢复/source 验证与旧 P1 supersession 见[当前恢复记录](2026-10-07-yuk1346-main-streaming-recovery.md)。任务报告 PR1593 已由另一 owner 部署，本 lane 未复验。

## 已观察的产品行为

精确源码 fea545aa1a853b1cc04da8e015bc3b40e61c4d1f，候选 ARM64 image sha256:bc9ab74220bd99be87a2ae72d60215899922261c998b288407b2ab7f9289c0f8。受限椭圆题 R4 的完整公开答案通过 existing_answer 判决、事实依据、独立盲解、全文 semantic correct 0.98 与教学检查。父核对数学 a²=25、b²=9、c²=16、焦点±4及浏览器刷新显示。受限轮 ingestion 没有 provider、queue、memory 增量；普通 A 的实际模型输入不含 R，A 完成并产生1024维偏好记忆。

原验收目录 /tmp/yuk1346-acceptance-driver/run-fea545a-01。R4 run copilot_user_ask_716cec3ba4a32dadcc1b77a60325aa0894799754cd5e0b67816ce17d16eee787；A run copilot_user_ask_56f67681c56affd6fb849078cac6d86b02f2f296d44b3ea04b169a8ca893ca1d。completed-R SHA cd6b96d4c183b707f3015202b2fe750cbc9ddd35377ab2bf8adefc07e943dbc5；completed-A SHA ad6ad6fa151d067142a269cd3eda746647958fe590f19c197f0b72423e2fd070；restricted-ingest SHA f26ee7b944e4cfa89f7be152d890bb47d8d36ee112112f253e82e92f5c3e4934。原件保持封存，不公开原始提示或思考。

## 失败及保留义务

提取成功后，验收脚本的未加引号 SQL alias 被 PostgreSQL 折小写，导致脚本在ACK前退出。物理 ingest e694ef1e-b7ef-457c-ba07-95648e4b5a6a 随后TTL过期，关联DLQ a8dd9b5f-ea85-4df9-a778-3f10ce04d681 保留。提取成功与物理任务失败分别记录，不重付、不清队列、不伪造ACK。

独立续验修正了观测脚本，不修改旧失败记录。r4 bundle ce43c6c5d7c8a873f2063ac461017dd53dbfaafb56ee39bbbc84b15efee0a589 的 observe/capture/finish-ingest 通过。第一次真实整理调用于08:52:51Z开始、08:53:51Z超时；attempt83073746-4d81-4170-93a8-dff152b303b6 为 aborted/provider_request_aborted、wire1，无 external request ID/usage/cost，无 reconciliation_log。不是 KEEP_BOTH 或成功，不重投。

父只读对照确认旧业务、事件、57条旧向量、旧调和记录及保留队列未意外改变；A产生的已知实体与SDK身份辅助写入单列。续验原本计划的SDK hook未命中pnpm真实路径，因此没有实际guard收据，不能声称运行了该guard。最终SQL只能证明观察到的一次同用户身份替换。

## YUK-1350 源码修复

诊断确认 direct reconcile 未启用已有 operation_kind start fence，普通同job重投可能发出第二次请求；这是源码及合成DB复现，不是宣称真实发生第二笔收费。另有 timer 在响应头后提前清除、未服从剩余deadline的问题。provider延迟原因仍未知，不擅自增加超时或改模型。

324381a3bb94486155d865d24e5ab504c97cafee 复用已有 fence，保留timer直到成功/错误响应体读取完成，在admission之后计算剩余deadline，并为实际未开始transport的情况记录wire0。保留未知费用、原始abort及HTTP/解析语义。

作者62 scoped unit、80 scoped DB、typecheck/lint/build及3 audits通过。DB使用独立testcontainers、真实handler/lifecycle加合成transport；旧源码复现第二次fetch，修复后off/observe/enforce模式同job重投总fetch=1，先前abort记录不变且无假结果或记忆修改。证据 /tmp/yuk1350-reconcile-safety-implementation/report.md。父已核对真实diff，独立42 unit与6个真实DB关键复验通过；没有第三轮PR审查、付费调用或生产写入。

## 当时未完成的验收

新修复的exact-head CI、候选运行及剩余全局brief/原key幂等/重投/最终数据保护验收。旧R4/A实际结果不能冒称新镜像全量验收。新发布仍需新镜像、停写后新鲜备份与恢复验证。生产42 failed/42 DLQ保留。

已知累计模型估算USD0.020229617；SDK add/search/embedding及超时整理成本未知，继续占用既有保守$2预留。YUK1348记录普通回复错误否认记忆能力，YUK1349记录LaTeX显示问题，均未修。用户数据和历史失败不为得到绿色检查而删改。


## Main integration after Laminar merge

Normal merge of main a86d4e633a67f802554ae114387ab06b7110c135 retains both observeTaskOperation finalization spans and the !answerOnly guard on SDK session retention. Parent inspected the auto-merged durable run wrapper.93scoped unit tests,typecheck,lint and full build passed; scoped Copilot teaching/run-input DB checks passed. No full local test suite,model call,production change,or new review round. Exact-head CI and fresh runtime acceptance remain pending. Previous365871dab/fea545a actual evidence stays tied to those versions.

/tmp/pr1588-main-unit.log SHA256 93f4fe955ad365ebeff3f07052e98d8816d6b71a241f7d3ee2b044f0a641196c

/tmp/pr1588-main-db.log SHA256 683660412f406c39975e9b5c048d3e2b4a7ec8e438e5ebf1aeb1830d034162e3

/tmp/pr1588-main-typecheck.log SHA256 8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92

/tmp/pr1588-main-lint.log SHA256 5476a9cd5b84878be843e8ef7ef4076323e33523bec3698d431fed4c43872784

/tmp/pr1588-main-build.log SHA256 da87233c1a5cee741da788f596da031009205b7ddde2be3cc70d29b794ae0ed3


## 42987dfd7 main integration, local only

本轮在独占 worktree `tlp-yuk1346-reconcile-safety`、branch `fix/yuk-1346-reconcile-safety`，从干净 `77d1656c7358c3b9f04d1e91e2065c3634932e84` 普通 merge `origin/main` 的 `42987dfd7d456ca187e716509d11ea100e7353b9`。这是两个 merge parents，不 rebase/force。只有 `PLAN.md` 和 `.remember/now.md` 文档冲突，按两侧实际版本与 Owner 当前限制合并；所有代码自动合入。

相对第一 parent，源码仅新增 main 的 `src/capabilities/practice/testing/pi-dbos-gate/{manifest,operations}.ts`，以及 gate 测试、原封存证据、DBOS 5.2.11 devDependency/lock 和 unit partition。其余整个 `src/` 逐字节不变，因此 answer_only 的 fail-closed 派生、模型历史/SDK session、YUK-1350 operation_kind providerStartFence 与未知结果不重试、Laminar finalization 均保留。gate 源码、测试、依赖、分区及原 evidence/doc 逐字节等于第二 parent。没有以全取一边覆盖代码。

Owner 完整非 UI 迁移优先，UI 暂缓；主 runtime agent TESTONLY，旧 automation disabled。YUK-1352/1355/1356 在各自其他树实施，本树不触及。main gate 对未知结果重调可控替身的场景不能授权真实付费重试；其生产化要求仍归原 YUK-1356。

本轮 scoped 检查在清理过的子进程环境执行，仅保留 PATH/HOME/TMPDIR/USER/LANG，不继承现有 DB/provider 环境；迁移连接由 globalSetup 固定为 fresh Testcontainers URL。DB config 的 globalSetup 新建 pgvector Testcontainers、迁移并克隆 fresh fork databases，未使用 existing DB。gate 子进程只收到隔离数据库与显式测试参数。结果：

- `pnpm install --frozen-lockfile` exit 0，未改写 manifest/lock。
- `pnpm vitest run --config vitest.unit.config.ts tests/pi-dbos-gate/contract.unit.test.ts src/server/memory/reconcile-llm.test.ts src/capabilities/copilot/server/copilot-execution.unit.test.ts`：3 files / 57 passed。模型为合成 seam，不调用 provider。
- `pnpm vitest run --config vitest.db.config.ts tests/pi-dbos-gate/recovery.db.test.ts src/server/memory/reconcile-handler.db.test.ts -t 'Pi|direct provider-start fence after abort'`：2 files / 16 passed、24 skipped；10 项 Pi + DBOS 真实子进程恢复，6 项 direct fence/deadline，transport 为合成替身。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:partition` 均 exit 0。lint 297 既有 warnings；partition 的既有启发式提示不等于新增分区失败。没有修改规则、baseline 或 exemptions。
- 源码比较和 `git diff --check` 通过。没有新的源码冲突，无需重跑与这次 merge 无关的旧整套验证。

日志与本轮 gate 合成证据单独保存在 `/tmp`，main 原封存 evidence 不被覆盖。

| Artifact | SHA256 |
| --- | --- |
| `/tmp/yuk1346-merge-42987-install.log` | `0bf1076d1cd84e8a11e439609d21d8fbfa35ea30a642e0175da280627b426f86` |
| `/tmp/yuk1346-merge-42987-unit.log` | `b6c4aaeaa965e6775013f091bb44b03072235d2073badc7fd25c05784b312376` |
| `/tmp/yuk1346-merge-42987-db.log` | `ae41d6142782238d318a9c320dca406bb5ae26d681eda0833571a4d8a0a172b1` |
| `/tmp/yuk1346-merge-42987-typecheck.log` | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` |
| `/tmp/yuk1346-merge-42987-lint.log` | `d8fe28d97a4f9b51ff5d5746eac99836a4a8208c1e59870c075bd17f8f0d51b7` |
| `/tmp/yuk1346-merge-42987-build.log` | `be8c232e77265a851422a9c34001f079aeebda1fe563894c176144ee1b93d7e0` |
| `/tmp/yuk1346-merge-42987-partition.log` | `ef5ba51eada64d944fe1ebb07c74d9eb2f537d9a506f67ddc3363b5a9df4a9ee` |
| `/tmp/yuk1346-merge-42987-source-check.json` | `103ae551bd5b681a896b9d8908efd4e3199a8f968db6dda1161b49960f64c26d` |
| `/tmp/yuk1346-merge-42987-gate-evidence.json` | `3ad48f8e4d61500b70f2d4e9e3ad4e37f3b4a25098c6ff46c1f481420cd787ac` |

旧 fea545aa1/365871dab 的真实 R4/A/提取和 77d1656c7 前的本地证据仍归属各自版本，不能称为新 merge 运行验收。本轮无完整本机 pnpm test、主 runtime/候选、existing DB、付费 provider、push、PR 操作、watch、GitHub merge、部署、委派或新 review；审查预算保持已耗尽。

capture gate：本次没有发现新的 actionable bug/follow-up，既有 YUK-1356 生产化要求与 YUK-1347/1348/1349 等继续保留，不新建重复票或改 SaaS 状态。父线程接回后负责新 exact-head CI 与候选/真实运行验收、全局 brief、原 key 幂等、completed redelivery 和最终数据保护。未知整理请求及旧 R/R2/R3/R4/A/提取不重放，失败/DLQ 义务与未知成本不改写。此次仅完成本地 merge；本实施子任务提交后 completed/noPending，释放写权。
