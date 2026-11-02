# YUK-1355 源码交付 PR 基线

父 B 起点 `9ce33e61da3ee40c7e89256212a7aedaf0b88e9d`，分支 `feat/yuk-1355-receipt-reference`。本轮 fetch 固定 main 为 `a7b838b06a3e8bd86b0eb5626487a378e538099e`，共同祖先 `a5ce564bbd3a0ed9153a0f9fabc5b69dc435e51d`。起点 ahead 48 / behind 7；在原分支正常 merge，无 rebase、force、新树或冲突。固定交接提交由 Git 的两个 parent 绑定。

本次交付是源码 PR 基线。父任务拥有 PR/create/push、exact-head CI、既有 review budget 和 runtime。没有新增 review/children、DB、Docker/testcontainers、provider、凭证、锁、PR、push 或 Linear 操作。当前运行窗口仍归协调线的 feature queue。

## 变化和保留

main 的 67 个变更文件全部逐字节保留。与本分支原有 156 个变更路径没有交叉；自有产品、测试、SQL、journal、worker/manifest 都与 `9ce33e61d` 相同。保留 main 的自动可判/必需图像准入、已接受提交和冻结 issuance 恢复规则、typed unavailable/withheld DTO、UI 选项标签、390px Inbox 换行、已批准打印/R10 设计和 CI fixture 修复。

唯一新增自有修正是四处旧证据排版：`yuk1355-a-import-initialization/{checks.json,product-files.json,compare-ast.cjs,import-paths.cjs}`。它们在旧轮次 lint 后落盘，完整 lint 本次发现四个格式错误。JSON 值与 helper Program AST 均等价，旧 failure logs 和 AST 比较结果没有改写。没有产品逻辑、断言、baseline、auditor 或 allowlist 修改。

共享 transaction、claim/fence、不可变 result/application、unknown/held、历史 disposition 和 owning-job terminal guard 全部保留。默认仍 pg-boss；`note_verify`、`item_prior_backfill`、`judge_calibration_sample` 的 ownership switch 继续拒绝。三个显式候选没有增加注册或 cutover。目录公共出口及其实现保留原有职责；YUK-1482 的已知循环仍在 backlog。

SQL 编号检查仅读取源码 journal/schema/snapshot。fetched main 止于 0118，没有 SQL0119 碰撞，因此保留 `0119_yuk1355_paid_effect.sql` 和原 snapshot/journal；没有 renumber、历史 SQL 修改或 DDL 执行。snapshot 的 prevId 对应 main 的 0112 snapshot，历史手写 0113–0118 仍保留。不能把源码检查称为本轮 live DB schema 检查。

## 当前源码 gates

Node 24.19.0 / pnpm 11.13.1：自有 scoped units 87/87；合入的 assessment pure contract units 55/55；typecheck、build、最终 lint、boundary/architecture/census/partition/test-policy 均通过。boundary 精确为 428/0/48，test-policy 的比较基线明确为 fetched main。lint 的初始格式失败和修复后的结果分别保留，不倒写旧结果。172 个既有 warnings 保留。

逐文件 source 保留、格式等价、编号检查、semantic delta 和命令/日志见 [证据目录](evidence/yuk1355-main-source-baseline/)。本轮没有剩余静态 blocker；没有证明 full template、worker 进程恢复、真实 provider、learner journey 或整体 runtime exit。

## DB 证据必须分行保留

| 窗口 | 固定来源 | 实际结果 | 不能外推 |
| --- | --- | --- | --- |
| DB05 shared | `403c72486` | 34/34 PASS | 不是三族 consumer/process/cutover 验收 |
| DB06 C + switch | `288acbe82` | 23/24 PASS，1 FAIL | 原失败保留；不是 clean C 全量 PASS |
| DB07 focused | `366bd301d` | 3/3 PASS | C fixture 修复及两项恢复邻例；不与 DB06 拼成 clean batch |
| DB08 A | `cb1deee1b` | 10/28 PASS，18 FAIL | 原 import-order 产品失败保留 |
| DB09 focused A | `ed023d5de` | 24/24 PASS | 18 旧红例 + 6 moved cases；另 10 outside scope，未 clean 全量重跑 |

每行的 source、artifact 和 digest 均沿用父已有 versioned receipt。本轮没有新 DB 结果，也不把这些窗口合并成当前 head 的 clean PASS。

## 哪些 delta 需要 DB，哪些只需源码检查

相对 `9ce33e61d`，本次自有新增 delta 只有证据排版；没有新的 paid-effect DB/SQL 语义，也没有 migration renumber 所需的新 DB case。现有 DB05–DB09 覆盖仍属于它们各自的 revision。

相对 `9ce33e61d`，main 合入了真实 DB-backed serving 变化。这些变化不是 DB09 的验证范围。父若声明合成 head 的 DB/第一天旅程通过，须另保留相应 DB 验证：

- automatic serving/figure admission、冻结 issuance/已接受提交恢复及 paper withheld slots：`src/server/assessment/admission.db.test.ts`、Practice 的 `placement-native.db.test.ts`、`paper-cycle.db.test.ts`、`review-sessions.db.test.ts`。
- prospective stream/due/variant/rehearsal filtering 与已接受旧合同恢复：`stream-store.db.test.ts`、`api/stream.db.test.ts`、`src/server/rehearsal/rehearsal.db.test.ts`。
- 上游 DBOS cron/outage/horizon fixture 改动是测试/worker-fixture delta；它们不改变本族事务，但其进程/定时恢复结论需要对应 DBOS window，不能用本轮单位测试代替。

完整 source-to-test 文件映射见 `semantic-delta.json`。本轮只跑已授权的离线 gates，不预占或启动新窗口。pure serving contract、UI presentation、生成契约与文档 delta 分列记录；其 source/build 通过也不代表浏览器或生产验收。

## 可直接交给父任务的 PR 文案提纲

建议标题：`feat(YUK-1355): add shared paid-effect ledger and staged family consumers`。这是部分源码交付，使用 `Refs YUK-1355`，不要自动关闭整票。

仓库模板的三个字段：

- 交付阶段：收据族共享基座和 Notes/Practice 三个显式候选源码；保留 pg-boss 真实消费者。第一天能用的 backend/source 环节，尚未通过完整 learner journey 或 runtime exit。
- 对应审计根项/契约：YUK-1355 的唯一 paid-effect owner、原始 dispatch/generation、不可变 receipts、unknown 不重放、transaction/fence、terminal owning-job recovery；main 的 YUK-1445 serving policy 原样保留。
- 删除了什么旧东西：删除 superseded server/durable protocol/store/note-admission/calibration-store 实现并迁移消费者；保留旧 pg-boss driver、注册和 recovery，不声称已退役。

Summary 用这个最小职责图解释 PR：

```text
core/migration/paid-effect-protocol   纯身份/状态/收据契约
db/paid-effect-{store,control}        共享 PG 事务与 admission
notes/server                         既有 claim 权威与 Notes projection
practice/server                      A/C 操作和真实 store adapters
server/durable                       显式 step/switch composition，未 cutover
```

Evidence 引用本轮源码 gates、四入口初始化修复的 before/after、原 AST 保留证据，以及上述五行 DB receipts。Merge Danger 说明 SQL119 仅新增两表，但迁移执行并写入 paid receipts 后，源码回退不能删除历史记录或盲重放未知效果；impact 是 durable paid-task consumers。附加明确状态：本轮未 apply schema、注册新候选或切换 owner。

## 父任务的下一步和 YUK-1355 出口

1. 在固定交接 head 上创建源码 PR、push 并绑定 exact-head CI。沿用已经结束的 R1/R2 budget；本轮没有第三次 review。若 main 又前进，另记录新差异，不能把当前 source seal 外推。
2. 第一天能用阶段继续按 PLAN 的照片导入、starter/placement、自动可判、Notes、判分语义、隐私、长任务回执和危机路径验收；UI 由既定 owner 完成。真实空库首日旅程须包含墙钟上限、确定性兜底和 learner-visible outcomes。本源码 slice 只提供保留消费者和后续迁移边界，不能替代这些 gate。
3. YUK-1355 root gate 继续逐族核原生产者/dispatch、旧队列义务、唯一 recovery owner、staged/application 事务、unknown hold、取消/版本冲突和真实 cron/进程恢复。三个 unsupported switches 只能在各族 versioned producer/retained drain/cutover 证据齐备后解除；随后才可串行注册/切换。
4. full template/runtime exit 还需所有旧实际消费者和恢复职责迁移、旧 driver/queue 排空、备份/恢复与唯一恢复 owner 证明。当前静态 audit 和目录迁移均不关闭这一出口。YUK-1482 cycle 后续保持 backlog，不在本 PR 扩张。

父任务继续拥有这些接受与调度决定。本 lane 交回固定源码 checkpoint 后释放 B writer；不修改全局 tracker 或抢占 feature runtime queue。
