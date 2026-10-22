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

1. 开外层事务，取 operation 级 advisory xact lock。
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

锁序为 operation → session → sorted blocks。不同 review operation 同 session
由 session 锁串行；只有第一笔能通过原状态守卫。相同 operation 重复 delivery
由 op 锁串行，后续读取终态而不修改业务。classic review 不调用 import guard，
不绕过或放宽 import 的 extracted/reviewed 限制。

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
实测 capability→server/server→capability-deep/cross-capability-value 为 327/0/39，
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

## 验证与验收边界

依赖安装、typecheck/lint/build、生成器及本片相关静态 audits 全部经外部
heavy.sh 串行执行，复用全机两槽且本线最多一项重活；不覆盖 NODE_OPTIONS。
以下实际执行均 exit 0。日志名统一前缀 `yuk1522-classic-review-`，交付后封存于
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
