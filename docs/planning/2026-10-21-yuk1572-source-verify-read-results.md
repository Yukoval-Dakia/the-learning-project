# YUK-1572 — 来源核验的去重读取与结果投影

原始实施基线 `83bbecdaecaf70be0ae0241795fac3d5a07940c1`；当前整合基线 `67506c5eaa5604ba34d2c943132343bf2e7fab5e`；分支 `arch/source-verify-read-results`；唯一 worktree `/Users/yuqi/.t3/worktrees/the-learning-project/t3-f0139945`。已 fetch 并从最新 main 开始，未带父旧 docs。#1910 的 `source_verify_prechecks.ts` 原样。

占用状态：主线逐 hunk 释放、父线明确批准后，已原子接入原 `checkDedup` 337–386（含紧邻职责注释）、`solveCheckToOutcome` 388–397、纯结果投影 1019–1042 与必要 import hunk。冻结投影 496–668 仍保护；自己准备的未接入 `source_verify_input.ts` 已删除，不纳入提交。

## 完整职责与真实收益

`jobs/source_verify_dedup.ts` 拥有完整池内去重读取与判定：ANY-KC overlap、NULL-active 可见性、排除自身、LIMIT 50、原候选遍历/首个最高重合者、原阈值、无信号 pass 与原理由文案。`checkDedup(db, row)` 接口未改变；它原本已封装，本片是职责迁移，不称新增接口深度，也不宣称只读 DB 函数为纯函数。

`jobs/source_verify_result.ts` 拥有 solve 结果到 check 的映射，以及已决定 promote 后的 failing-check/summary/unified 完整纯结果投影。`projectSourceVerifyResult` 接收原六个输入（checks、promote、未决 exact mismatch、图像不可用、knowledgeAlive、vectorNearHold），返回原 check 对象引用和原 unified 结果。新增隐藏的是 `checks.find` 与 summary 优先序/文案/统一结果映射；caller 仍须决定并提供六个事实，没有隐藏或重算准入策略。solve 映射原本已封装，单独迁址不计深化。

三个新私有 export 都有 job 真实消费者，无再出口、stable/compat、registry、白名单或无意义转发。旧 `DEDUP_OVERLAP_THRESHOLD` 出口不动。

## 两个真实维护场景

1. 调整 draft review 显示的结果摘要优先序，例如失败 check 与未决 exact mismatch/图像不可用/归档知识/vector hold 同时存在时先说明什么：之前在含 paid、锁及发布逻辑的 job 内修改 summary 与 unified 构造；之后在纯结果模块修改。两边本都是单处实现；新增收益是 caller 退出该结果选择过程，`promote` 和所有布尔事实仍由 job 决定。当前优先序与字面量完全不变；draft-review consumer 不改。
2. 调整来源去重的候选可见性/扫描界限：之前改 job 内已经独立的 `checkDedup`；之后改去重模块。仍是一个实现位置，也仍依赖共享 notDraftPredicate/阈值 owner；收益是完整 DB 读取决策与 job 付费/发布编辑面分离，不声称减少原本不存在的重复。当前 SQL、LIMIT、顺序与阈值均不变。

这些是源码可定位的真实维护方向，不是本片实跑或实施的新业务行为。

## 五标准与保护证明

1. 完整 owner：去重查询与判定一并迁移；结果投影只展示原 facts，不裁决准入。
2. 两个变化场景及修改位置如上，迁址收益和新增隐藏知识分别计账。
3. caller 退出结果摘要中间态，保留原六输入知识；去重 caller 原本已不知 SQL，不能重记该收益。
4. `publishVerifyLifecycleUpdate`、冻结快照/投影/双身份、claim fence、solve/grounding 调用及失败降级、锁序、独立准入证据、发布/撤销、paid 结算、终态与 catch 均保留原正文。Date/createId/actor 原 1004–1006 的产生位置不变，先于纯结果调用。返回 failingCheck 仍指向原 checks 数组成员；unified 的 map 与字段/文案/优先序原样；检查数组顺序与 dedup await 原位。源码逐段比较不是运行验收。
5. 按主线实际释放的完整职责实施；主文件实际 1606→1525，仍超过1500，不称超长清零。冻结输入投影候选因未释放已撤回，没有越界实现。计数/baseline 由父线实测登记，本 lane 不动 audit/schema/CI/package/lock。

## 完整直接 caller 清单

- `source_verify_dedup.ts::checkDedup`：仅 job 的 tier-2 dedup 分支，原 808 行；调用表达式与 await 顺序不动。
- `source_verify_result.ts::solveCheckToOutcome`：仅 job solve 分支，原 835 行；原 solveResult 同一对象传入。
- `source_verify_result.ts::projectSourceVerifyResult`：仅 job 原 1019–1042 位置，同步调用一次。
- 原 job 模块外部 consumer 保持原样：`practice/manifest.ts:818` 动态取 `buildSourceVerifyHandler`；`practice/server/quiz/verify-and-promote.ts:40` 取 `publishVerifyLifecycleUpdate/runSourceVerify`；`practice/jobs/source_verify.test.ts:43` 取 `runSourceVerify`（仅静态读取，测试未改未运行）。handler 内部逐 job/题调用不动。全仓 tracked import/dynamic import、namespace/re-export 与路径字符串搜索没有发现额外代码 consumer。

## 证据与验证限制

准备态完整 patch、源码及 SHA256 已封存于 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/83bbecdaecaf70be0ae0241795fac3d5a07940c1/source_verify-prepared-20261020T221915Z/`；patch SHA256 `04bf0436087fba75047fb53403d4fdcb2d57703e7106b581914fe2365c16c3c5`。该目录记录的是候选，不能冒充已接入状态。已接入源码比较封于同一基线目录的 `source_verify-source-proof-20261020T222121Z/source-proof.json`，SHA256 `0b72721572a5bba03358ac994b7c374b6e10f54859f8b4747e2c5d1c60b93a8a`：三个受保护正文区及原 prechecks 全文 IDENTICAL，dedup/solve 迁出体除 export、result 投影除缩进均 IDENTICAL。commit 后按 exact-head 另封最终文件 hash、git diff 与真实命令退出状态，不覆盖旧 seal。

父线于源码 head `3468f41a283d40c46d27783b757ec22e82bf4614` 完成唯一一次 heavy frozen install（rc0），package/lock/workspace hashes 前后一致，回执见该 head 仓外目录的 `parent-frozen-install.json`。本 writer 未 install/update/复制依赖。随后 fetch 并普通 merge 最新 main `20222f2cafe1500a9e445b43fe132935405d825a` 得到 `854652e87cb147c04ece5ba354e9dc53011a6410`，无冲突；己方4个文件与上游3个publication文件 blob 均保留，依赖 hashes 与安装回执一致，无须重装。

首轮五门经 heavy.sh 串行实跑：typecheck/build/两audit rc0；lint rc1（180 warnings，唯一 error 为本片 `source_verify_dedup.ts` 的 import 换行格式，非上游问题），已审源码提交 `668a3974ebcefd40cd7d2072d460780eb8d70fea` 只将该 import 折回 formatter 要求的单行，函数正文原样。首轮 raw stdout/stderr、argv、UTC、真实 rc 封于 merge head 的 `source_verify-five-gates/`，诊断另封 `source_verify-lint-diagnostic/`，不覆盖。

首轮实际 audit：capability→server403、deep0、cross37、SCC1（agency/knowledge/practice）、超长13（新 main 基线13）；本片 source 仍1525，不能据13减少再归功本片。baseline 无变更，两audit均无新增站点或需登记变化。格式修正后的已审 head `668a3974ebcefd40cd7d2072d460780eb8d70fea` 五门已全部 rc0（lint180 warnings），其真实结果与 raw 证据封于该 exact head 的仓外 `source_verify-five-gates/`，不拿旧轮替代。


## 唯一 R1 后的 main 整合

父线通知唯一 R1 对 `668a3974ebcefd40cd7d2072d460780eb8d70fea` APPROVE；这是父线提供的审查裁定，本 writer 未启动新审查。fetch 后最新 main 确认为 `67506c5eaa5604ba34d2c943132343bf2e7fab5e`（#1912 JSON 算法归属迁移），普通 merge 得到 `68d4ae0baf3649589e21ed7b007118517071af54`，无冲突。三源码 blob 均与已审 head 相同：job `a3cf667fe619d258308e50358f25db8400a7a792`、dedup `30a3b616f29c408e1d9c958de517777855ad3fb5`、result `108798d6a66f7ac0112e3bc53889309d4300ccc5`；本次仅更新此交付文档。

main 全树4461个 tracked 条目按 mode/type/blob 核对，除明确列出的本片四文件外均保留，无丢失或改写上游条目。main baseline 全文 blob `4c4154f785b0f2ae2dadc2f2e3223809117a8984` 原样保留；changes22、edgeRecords20、sourceSizeRecords1、compatShims7 的 main 前缀和全数组均相同，本片 baseline 零 delta。main 声明 debt394/0/37、SCC1×3，相对上一轮403的下降来自上游JSON片，不计入本片收益；该数字为 main baseline 声明，新的实际 audit 以本提交 exact-head 五门回执为准。source仍1525行。

整合与账本核对原始回执封于仓外 merge head `68d4ae0baf3649589e21ed7b007118517071af54/source_verify-r1-main-integration/`。package/lock/workspace 三hash仍与父唯一 install receipt 一致，本轮没有重装。文档提交后的新 exact head 须经 heavy.sh 串行重新执行 typecheck/lint/build/两audit；raw stdout/stderr、argv、UTC、真实rc放在 `architecture-deepening/YUK-1572/<本交付git HEAD>/source_verify-five-gates/`，最终源码/body/main全树与账本证明放在同 head 的 `source_verify-r1-final/`。不复用旧head检查，不覆盖旧seal。

所有 tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、push/PR/watch/review/Linear/部署/清树均 NOT_RUN；测试代码零修改。未发现本范围之外的新 actionable follow-up；父线继续负责独立验收、PR/CI与既有 YUK-1572 整票义务。
