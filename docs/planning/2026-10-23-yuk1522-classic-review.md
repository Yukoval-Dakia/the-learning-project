# Classic block 显式复核后端操作

Refs YUK-1522；交付阶段：第一天能用。审计契约：用户确认的完整 block/version
集合才可把 classic ingestion session 从 extracted/partial 转为 reviewed。
reviewed 只表示复核检查点，不表示 published、admitted 或 servable。

## 基线与范围

- 唯一实施树：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-9a6e9151`。
- 旧 HEAD `ee4b92bea329dde7d88609469e217dd2bb473c1d`，旧分支保留。
- 本次一次有界 `git fetch origin` exit 0；实际 `origin/main` 为
  `b7cb235e9918e2bbfb29a66c2108da333752a63b`，旧 HEAD 落后 279 commits。
  正常从该 main 新建 `feat/yuk-1522-classic-review-20261023`。
- 不改父 stage1-lead、UI、测试、数据库 schema、provider、预算、agent 恢复、
  shared publisher/admission、完整 import 业务或其他 session 转移。
- 父线程核开放 PR：#1958 与 blocks/import-completion 同文件，但其注释 hunks
  与本片 SELECT version/追加 review 操作无交集；保留现役 import/kernel 路径。
  生成物从本树 main 运行既有生成器，不取其他分支整文件。

## 请求与资源

现有资源 `POST /api/ingestion-sessions/{id}/operations` 新增：

```json
{
  "kind": "review",
  "input": {
    "checked_blocks": [
      { "block_id": "实际 block id", "version": 3 }
    ]
  }
}
```

沿用 `Idempotency-Key`（建议必带，原契约 1–200 字符）及资源的 Location、
poll、events_url/SSE。请求数组非空、block_id 非空且不重复、version 为非负整数。
schema 解析时按 block_id 的确定性字符串顺序归一化；交换数组顺序仍是同一身份。
原 SHA-256(JSON.stringify(parsed request)) 指纹算法原样移入现有 operation-store，
由 reservation 与 review delivery 共用；其他 kind 的输入与指纹不变。

列举集合为当前 session 下全部 question_block 行，包括 ignored/auto_enrolled；
不只 draft、不抽样、不截前 N 项，也不混入 `draft:ingestion_agent:{id}`。
`GET /api/ingestion/{id}/blocks` 与输出 schema 新增必需的真实 `version`。
旧后端不含 version 时，客户端必须停止提交复核，不能默认 0 或从时间/题文推造。

初次创建返回 202；同 key 同规范化请求返回 200 原 handle；同 key 异内容
沿现有 409 idempotency_conflict。首次状态预检只接受 extracted/partial；
相同 key 的终态重放先取原资源，不再进入状态预检或复核。
成功资源 `status="succeeded"`、`operation_kind="review"`，且唯一业务结果为
`result={"status":"reviewed"}`。业务冲突在 operation.failed 的 error 中表达，
如版本/集合/归属不符时 error.status=409；客户端不能把 POST 202 当作复核成功。

## 完整事务 owner

真实调用链：operations POST → 既有 ingestion_operation queue/manifest →
buildIngestionOperationHandler 的 review 分支 → completeIngestionReviewOperation
（现有 import-completion.ts）→ Ingestion.markReviewedInTx。
review 不经 legacy HTTP adapter；没有新 URL、queue、registry 或工具。

completeIngestionReviewOperation 隐藏以下顺序：

1. 开外层真实业务事务，取与现役 dispatcher 完全相同的双参数 advisory xact lock：
   `hashtext('ingestion-operation-dispatch'), hashtext(operationId)`。在读原资源之前
   取锁，持续到 review 业务与 receipt commit；不另开连接包装业务事务。
2. 读原资源；不存在或终态直接返回，终态不重做复核。
3. 重新解析/归一化 delivery input，核原资源 kind/session，并用最初 accepted
   event 的 session/kind/input_hash 绑定实际请求。错误 delivery 抛出，不给真实
   operation 写假 failed。worker 也拒绝把 review handle 送进其他 kind/legacy adapter；
   malformed/重复终态 delivery 不覆盖原 receipt。
4. 同事务写 operation.running，进入 savepoint。
5. 锁 `learning_session(type='ingestion')`，随后调用现役 hasAgentEvidence /
   agentEvidenceSql；任意 agent operations/grants/history、run events、历史 draft
   或 source_ref 证据均拒绝 classic review。partial/agent 失败不作为 classic 证据。
6. 按 block id 排序取得全部 classic block 行锁，读取真实 question_block.version。
   空集合、数量不等、任何 id 缺失/外来/新增、任何版本变化均 409。
   session 锁与现役 extraction/import/rescue owner 的锁保持一致；不重读新版本替用户确认。
7. 调用 Ingestion.markReviewedInTx，由原状态 owner 重新守卫 extracted/partial，
   修改 reviewed 并写 ingestion.reviewed。原 markReviewed 只是以自己的事务调用
   该完整 seam；其行为与原有状态转移保持一致。
8. 业务成功后写 operation.completed，和 session/event 同一外层 commit。

锁序为 dispatch 共用的 operation 锁 → session → sorted blocks。不同 review operation 同 session
由 session 锁串行；只有第一笔能通过原状态守卫。相同 operation 重复 delivery
由 op 锁串行，后续读取终态而不修改业务。classic review 不调用 import guard，
不绕过或放宽 import 的 extracted/reviewed 限制。

发送结果不明且 D 的持锁连接仍存活时，dispatcher（D）与 review worker（W）按同一 operation 锁串行：

- D 先获锁：即使 boss.send 已独立提交 job 后丢失响应，W 仍须等待。D 在锁内写
  failed 或 queued 并释放后，W 才读取已提交资源；若为 failed，直接返回，不做 review；
  若为 queued，才继续原身份、classic/agent、完整集合/version 和状态守卫。
- W 已获锁并成功提交：reviewed、ingestion.reviewed 和 completed 一起提交后才释锁。
  后到 D 获取同一锁并读取 completed，终态短路，不再排队或写 failed。

这是源码锁域与顺序推导，未做故障注入或真实并发运行；不据此声称故障发生频率或运行通过。
API dispatch、TerminalOnce 通用语义及未变的 import/agent 锁保持原样。

上述共享锁只描述持锁连接存活的情况；R2 确认的连接关闭残余及当前 review dispatch
连接寿命修复见文末。不能从相同 namespace/key 推出 callback 会随事务拒绝自动取消。

业务 ApiError（4xx）先回滚 savepoint，再写原 operation.failed。基础设施错误、
5xx 或失败 receipt 写入错误退出外层事务，由 pg-boss 重试。DONE 写在业务 catch
之外，写入失败必须回滚 reviewed、ingestion.reviewed、running 与 completed，
不会留下业务已提交而资源假 failed。这里复用 TTL 内 operation receipt；不创建长期
幂等 receipt，不触碰 agent 未知成本、预算或重放身份。

## 依赖与源码差量

复用 import-completion 现有 Ingestion/operation-store 依赖；仅新增同 capability
内部 schema/history 调用。无新 capability→server、跨 capability 值边或 kernel
反向边。markReviewedInTx 有真实 review consumer，不以 pass-through/re-export
凑抵消。本片文件均小于 1000 行；生成物按原生成器排除规则处理。
初版 08e4f194 实测 capability→server/server→capability-deep/cross-capability-value 为 327/0/39，
新增依赖边 0、pass-through 新增 0、>1500 行文件 9→9，未修改 baseline。
本片最大产品文件 ingestion.ts 为 863 行；import-completion 520→618 行、
operation-store 435→469 行；没有触发需要登记的 size 增长门。

## 给现有录入 UI 的最小调用交接

1. 读取 GET blocks 的完整 rows；只把用户实际检查过的每行 id/version 放入
   checked_blocks，保留 ignored/auto_enrolled。没有 version 就提示版本不兼容。
2. 用户显式确认后使用一个新的 Idempotency-Key 创建上述 review operation。
3. 按 Location poll 或订阅返回的 events_url；仅 succeeded 且 result.status=reviewed
   才确认本次复核完成。failed 展示原 error；409 让用户重新读全量并重新检查。
4. 网络响应不明时沿原 key/原 body 查回原资源，不自动换 key、不自动确认新版本。
   review 成功后仍由现有独立 import/publisher/admission 路径决定后续结果。

本片不实现 UI consumer，不宣称现有页面已经接入。

## 初版 08e4f194 验证与验收边界

依赖安装、typecheck/lint/build、生成器及本片相关静态 audits 全部经外部
heavy.sh 串行执行，复用全机两槽且本线最多一项重活；不覆盖 NODE_OPTIONS。
以下为初版 08e4f194 的实际执行，均 exit 0；不覆盖后述修复组合。日志名统一前缀
`yuk1522-classic-review-`，封存于
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1522/<交付HEAD>/`，
实施回执给出完整目录。首次及最终 typecheck/lint/build 的原日志均保留。

| 命令 | exit | 最终日志后缀 |
| --- | --- | --- |
| pnpm install --frozen-lockfile（一次，6.8s） | 0 | install.log |
| pnpm gen:postman | 0 | gen-postman.log |
| pnpm gen:api-client | 0 | gen-api-client.log |
| pnpm typecheck | 0 | typecheck-final.log |
| pnpm lint（164 warnings，0 errors） | 0 | lint-final.log |
| pnpm build | 0 | build-final.log |
| pnpm audit:capability-boundaries --base b7cb235e… | 0 | capability-boundaries.log |
| pnpm audit:architecture-deepening --base b7cb235e… | 0 | architecture-deepening.log |
| pnpm audit:api-contracts（165/165 declared） | 0 | api-contracts.log |
| pnpm audit:api-client（已暂存生成物再重生成对照） | 0 | api-client.log |
| pnpm audit:api-client-usage | 0 | api-client-usage.log |
| pnpm audit:schema（1057 fields，0 unallowed stub） | 0 | schema.log |
| pnpm audit:draft-status | 0 | draft-status.log |
| pnpm audit:draft-status-reads --strict | 0 | draft-status-reads.log |

build 原有 chunk/bundle 大小提示、gen:postman 的未收录 endpoint 提示均保留在日志；
未为消除提示修改门或其他产品。push 前第二次正常有界 fetch exit 0，actual main
仍为上述 b7cb235e，HEAD..origin/main=0。gh auth status 预检无响应后终止（143）；
GitHub connector fetch_commit 另一次调用出现 transport HTTP request failed，
不据此否定成功 git fetch 的实际结果，也不修改网络/auth。

未写/改/运行任何测试或 fixture；DB、TEST、Docker、daemon、browser、provider、
付费、重放、部署均 NOT_RUN。静态编译/审计不证明真实 PG 锁、故障回滚、API/worker
运行或 UI 已接通。父线程负责 Linear capture、独立 R1 和 exact-head CI；
本子任务不 watch/poll/review/resolve/merge/清树。

## 独立初审 F1 修复与 main 组合

原 R1 固定 `b7cb235e…08e4f1940f1d3761a743b3559b6017a6b27570df`，
Standards/Spec 为同一去重 P1（F1）：独立的 review 锁不能阻止 dispatch 在
completed 尚未提交时追加更大 id 的 failed。原结论 CHANGES_REQUESTED 保留，报告位于
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1522-classic-review-20261023/review-r1-08e4f194.md`。
本轮只替换新 review 事务的锁 namespace/key，并记录上述两个顺序；accepted 身份、
session→sorted blocks、savepoint、DONE 回滚及 classic/agent 分类正文未改。

正常 fetch exit 0 后，实际 main 为 `4f8dde24ef33b8f2b990018fac81dae277910a42`；
相对旧 base 只有 source_verify、source-grounding-verify 和 baseline 三个文件变化，
与本轮产品 hunk 无交集。正常 merge 保留 upstream baseline 原文，不新增例外或抽象。
整合 commit 为 `7d955200f2295ef15870e7b706a23ea5d99d7c8e`；复用已就绪依赖，
不重新安装。修复后 import-completion 为 620 行，新增两行是共锁承重说明。

本组合以下各门实际 exit 0；全部经外部 heavy.sh 串行执行，不覆盖 NODE_OPTIONS。
日志前缀 `yuk1522-classic-review-f1-`，本轮按交付 HEAD 封存在仓库外
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1522/<修复交付HEAD>/`。

| 命令 | exit | 日志后缀 |
| --- | --- | --- |
| pnpm typecheck | 0 | typecheck.log |
| pnpm lint（164 warnings，0 errors） | 0 | lint.log |
| pnpm build | 0 | build.log |
| pnpm audit:capability-boundaries --base 4f8dde24… | 0 | capability-boundaries.log |
| pnpm audit:architecture-deepening --base 4f8dde24… | 0 | architecture-deepening.log |
| pnpm audit:api-contracts（165/165 declared） | 0 | api-contracts.log |
| pnpm audit:api-client（重生成无差量） | 0 | api-client.log |
| pnpm audit:api-client-usage | 0 | api-client-usage.log |

机器实测债务仍为 327/0/39，新增依赖边 0、pass-through 新增 0，>1500 行文件 9→9。
相对实际 main 的 upstream baseline 和另外两个上游产品文件均无本线差量。
本轮没有测试、fixture、断言脚本、hash/seal 或运行操作；真实并发/响应丢失故障仍 NOT_RUN。

旧 08e4f194 的 GitHub CI `39859497373` 全 18 success（Gate `120107825879`）与
Circle 全绿是父线程交付的旧 head 事实，不代表本轮修复已获 CI 或运行验收。
仅父线程另开唯一 R2；本 writer 不 resolve R1、不启动新审、不合 PR、不取运行证据。

## R2 残余：review dispatch 的连接寿命与提交顺序

原 R2 固定 `4f8dde24…a0c925e452a9aab95843ba628a53873491307913`，
Standards/Spec 同一 F1 仍 OPEN、CHANGES_REQUESTED；原报告保留：
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1522-classic-review-20261023/review-r2-a0c925e4.md`。
正常 D/W 共享锁的两个顺序已关闭；残余有不同前提：D 的持锁连接关闭，外层事务已拒绝，
仍在等待独立 boss.send 的 callback 没有被取消，随后可从 global db 写 failed。

实际已安装 postgres 3.4.9 的 `begin` 使用 Promise.race，scope callback 不会因为
onclose 获胜而停止；onclose 清除 reserved 并可能重连/复用 connection 对象，scope
handler 仍直接 c.execute。因此旧 Tx 的类型或对象存在本身不能证明还持有原事务锁。

本轮沿用现役 dispatch-lock 原语，仅透传 tx 与显式的 AbortSignal 生命周期。
原语直接在持锁事务 promise 的 finally 中使 signal 永久失效，然后才向调用方暴露
成功或拒绝。signal 不依赖 driver 的 connection 对象，重连/复用不会使它重新有效。
既有 caller 实际只有 operations；新 review 分支使用 tx/signal，其他 kind 原 callback
正文保持原样并忽略新增参数。没有修改通用 TerminalOnce、driver、worker 的 review 事务，
没有增加跨 capability/server 值边、registry 或独立框架。

review 的私有完整 dispatch 入口隐藏以下分支：

1. 在持锁 tx 上读取原 operation，检查终态、running 和 queued receipt；终态/running/
   已 queued 返回原资源。资源 reader 显式接收 tx，旧 kind 仍使用原来的默认 db。
2. 保持共锁并调用既有 boss.send，其 job 提交仍是独立 pg-boss 连接。getStartedBoss
   和 send 的 await 之后都检查生命周期；不能因网络 await 完成便推断锁仍然有效。
3. send 成功且 signal 仍有效：同一 tx 写 queued，再同一 tx 读回资源；每个后续阶段
   前后检查 signal。返回 resource tag，等实际事务 commit 成功后再生成 HTTP 200/202。
4. send 拒绝且 signal 仍有效：首次 reservation 在同一 tx 调 TerminalOnce，写 failed；
   返回 error tag 让事务 commit，外层 await 完成后才抛原 error，由 POST 转成 HTTP 错误。
   重放的非首次 reservation 保持原来不追加 failed 的语义。send 已 resolve 后的 queued/
   readback 错误不变成假 failed；没有抛错导致已写 failed 随同一事务回滚的问题。
5. 事务本身拒绝或 commit 失败：直接向 HTTP 拒绝，没有外层 fallback/global-db 写入。
   若 callback 当时仍停在 send，之后 send resolve 会在 queued 前被 signal 拦下；
   之后 send reject 会在 catch 的第一步被 signal 拦下，不能进入 TerminalOnce/failed。
   即使 driver 复用原 connection 对象，也不能让这个过期 continuation 使用旧 Tx 继续
   receipt/readback。这里终止业务 callback 的后续，不宣称修改或验证了 driver 的清理机制。

锁连接存活与关闭的因果边界分别为：

- 存活：read→send→queued 或 failed→commit→HTTP，D 全程持有共锁，W 随后重读终态。
- 关闭且外层已拒绝：signal 已失效，W 可获得释放的锁；D 的晚到 send 完成/失败仅终止
  过期 callback，不进入 queued/failed/readback，因此没有 global-db 迟到终态覆盖 W。

accepted 身份、classic/agent 分轴、full set/version、session→sorted blocks、savepoint、
DONE 回滚及原 import/admission/paid/预算保持不变。以上是源码与依赖源码推导；未做连接
关闭、连接复用、send 响应丢失、故障注入或真实 API/worker 并发运行，发生频率 unknown。

本轮起点 a0c925e4，正常只读 fetch exit 0 后 actual main 仍为
`4f8dde24ef33b8f2b990018fac81dae277910a42`，无新交集；按 owner 指令不 merge main、
不 push，只固定本地候选交父线程核因果。复用依赖，不 install；不新增或修改测试/fixture/
断言脚本，不运行 tests、DB/TEST、Docker、browser、provider、paid、runtime、重放、部署、
资源、daemon、config 或 hash/seal。不新审、不 resolve、不 watch/poll、不做 Linear 写入。

父线程专项许可的 a0 单次 db7 重跑记录与本候选分开：run39860706525 attempt2 success；
实际新执行 db7 job120115825858（22:05:24–22:07:03Z）success，自动 Gate120116563308
（22:07:07–22:07:11Z）success；其余 16 项是 API roll-forward 的首轮记录，不能称
18 项重执行。原 08006 与 root cause UNKNOWN 保留；没有再次 POST，也不能用 a0 绿
证明本候选。原 R1/R2 报告与 CHANGES_REQUESTED 不变，没有第三审结论。

本轮本地候选的真实静态门如下，均通过外部 heavy.sh 串行、各执行一次；未覆盖
NODE_OPTIONS，未重装依赖。日志前缀 `yuk1522-classic-review-lifetime-`，候选 commit
后复制到仓库外 `tlp-audit-artifacts/yuk1522/<本地候选HEAD>/`，完整路径见实施回执。

| 命令 | exit | 日志后缀 |
| --- | --- | --- |
| pnpm typecheck | 0 | typecheck.log |
| pnpm lint（164 warnings，0 errors） | 0 | lint.log |
| pnpm build | 0 | build.log |
| pnpm audit:capability-boundaries --base 4f8dde24… | 0 | capability-boundaries.log |
| pnpm audit:architecture-deepening --base 4f8dde24… | 0 | architecture-deepening.log |
| pnpm audit:api-contracts（165/165 declared） | 0 | api-contracts.log |
| pnpm audit:api-client（重生成无差量） | 0 | api-client.log |
| pnpm audit:api-client-usage | 0 | api-client-usage.log |

机器实测新增依赖边 0、债务 327/0/39、pass-through 新增 0、>1500 行文件 9→9；
未改 baseline。operations.ts 为 415 行、operation-store.ts 为 476 行，无新增产品文件。
只修改这两个 owned 文件和本正式 doc；import-completion 的正确 W 事务完全未改。
静态门不构成连接关闭/复用故障验收；本地候选尚未 push，CI 未迁移、未触发或查询。
