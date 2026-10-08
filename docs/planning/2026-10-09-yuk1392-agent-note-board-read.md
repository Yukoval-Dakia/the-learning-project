# YUK-1392 Agent-note board 公共读取

基线 main f80d47703；父票1358，整体退出1359仍 In Progress。1391已合入，不等于Start trait消费者或整页迁移完成。本线程7631承担整体交付责任，5796承担Start集成/发布；边界来自owner明确授权。

## Scope and contract

仅agency/api/notes.ts、agency/public.ts、必要server ISO DTO模块与scoped tests。原server/notes.ts selector、api/contracts.ts规则只读；无Start/UI/router/manifest/package/lock/writer/tasks/recovery修改。复用unfiltered readAgentNoteBoardRows，不替换成agent-filtered readAgentNotes。

公共输入与HTTP保持default20、positive integer、max200拒绝400非clamp，完整validation_error/errorResponse。Db|Tx显式注入，单次now；DTO created_at ISO并完整保留refs/provenance/expiry/unknown/enrichment。HTTP实际消费共享入口。已有Today20和agent-notes50不改。

## Evidence required

源码与mock测试不能代替真实DB：未提交非零Tx涵盖notes和每个关联lookup；全public表读取前后digest/count相同，rollback后fixture消失；同一now的HTTP完整DTO parity，expiry严格边界、稳定排序、20/50/200及非法输入、未知引用/空结果、长中文与嵌套来源。作者只scopedunit/static/build及适用audit，父DB实际核部署锁后独占执行。独立R1、exact CI与PR门禁。未完成部分不写PASS。

## Dedupe and ownership

1358全部10子票无重复，readAgentNoteBoardRows精确查询只有1359退出记录；历史294/311/313/629/293/907/1125不同scope。已建YUK1392。主线确认agency路径无重叠；只设一个writer。没有新增真相源或聚合层。Start挂载与页面真实验收归5796接续；领域slice不关闭1358/1359。

## Implementation handoff

实现基线为本分支 `5fa9d189117c5db3dc41023867012fa8a615cd40`，其 main 基线为
`f80d47703ffbcb6f8db488a10dd0a705a6fee601`。父拥有 PLAN、.remember、1359 文档、review、DB、PR 与 tracker；本次仅提交以下六文件：

- `src/capabilities/agency/api/notes.ts`
- `src/capabilities/agency/public.ts`
- `src/capabilities/agency/server/note-board-read.ts`
- `src/capabilities/agency/server/note-board-read.unit.test.ts`
- `src/capabilities/agency/server/note-board-read.db.test.ts`
- 本任务文档。

公共签名为 `loadAgentNoteBoard(database: Db | Tx, input: AgentNoteBoardQuery, now: Date): Promise<AgentNoteBoardDto>`。
`AgentNoteBoardQuery` 从原 `AgentNotesQuerySchema` 的 input 类型推导；该 schema、loader 和 DTO 类型均经 `agency/public.ts` 导出，供 Start 消费。
调用方传入 `{}` 保持默认20，也可传20/50/200或原 HTTP 可 coercion 的字符串。loader 在读取前按原 schema 拒绝非法 limit，原样构造 validation_error/400/message。GET 只取 query、注入 db 与一次 now、调用共享 loader 并保留 errorResponse。

`AgentNoteBoardDto` 是 `{ rows: AgentNoteBoardRowDto[] }`；row 类型从 selector 的 `AgentNoteBoardRow` 推导，仅将 `created_at` 改为 string。
实现逐 row 展开全部字段并调用原 Date 的 `toISOString()`，不通过会删 optional keys 的响应 schema 重建对象。
refs、label、resolution_state、usable_question_count、source task/run、caused_by_event_id、confidence、expiry 及 selector 返回的未知扩展均保留。
selector 与 api/contracts.ts 的字节未改，仍以原事件列作为 cause 来源，仍仅把 draft 排除出知识题量，其余状态和 null 的投影保持原规则。

## Local evidence

所有命令在此工作树执行，统一前缀为
`PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH`。
Node 为24.19.0，pnpm 为11.13.1，未 install。日志目录 `/tmp/yuk1392-evidence/`。

| Exact command after PATH prefix | Exit | Log |
| --- | --- | --- |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/agency/server/note-board-read.unit.test.ts` | 0，13 tests | `scoped-unit-final.log` |
| `pnpm typecheck` | 0 | `typecheck-final.log` |
| `pnpm lint` | 0，290 warnings | `lint-final.log` |
| `pnpm build` | 0 | `build.log` |
| `pnpm audit:api-contracts` | 0，173/173 | `api-contracts.log` |
| `pnpm audit:api-client` | 0，生成零 diff | `api-client.log` |
| `pnpm audit:api-client-usage` | 0 | `api-client-usage.log` |
| `pnpm audit:partition` | 0，747 unit/521 DB/1 migration，P0 none | `partition.log` |
| `pnpm audit:capability-boundaries` | 0，debt 433/0/48 | `capability-boundaries.log` |
| `pnpm audit:architecture-deepening` | 0 | `architecture-deepening.log` |
| `pnpm audit:schema` | 0 | `schema.log` |
| `pnpm audit:draft-status` | 0 | `draft-status.log` |
| `pnpm audit:draft-status-reads --strict` | 0 | `draft-status-reads.log` |
| `pnpm gen:postman` | 0，生成零 diff | `postman.log` |

`git diff --exit-code -- src/capabilities/agency/server/notes.ts src/capabilities/agency/api/contracts.ts postman/api-endpoints.json postman/learning-api.postman_collection.json src/ui/lib/api-schema.generated.ts` exit0。
wire 和 manifest 未变，故 Postman spec 无需修改。baseline/allowlist 未改。
首轮 typecheck exit1 是新增 unit fixture 的未知扩展字段声明不完整，已修正；首轮 lint exit1 是新增 DB fixture 的格式问题，已修正。历史日志 `typecheck.log`、`lint.log`、`lint-errors.log` 保留，不覆盖成通过记录。

## Prepared DB acceptance, not executed by author

新增4项 DB 测试由父持锁执行。第一项用真实 `testDb().transaction(tx => ...)`，不调用 beginTestTransaction、不重绑定全局 testDb。
事务内插入1 note、3 knowledge、5 question，原 Db 观察者确认三类 fixture 均不可见；Tx 中验证所有 enrichment，包括 null/未知 draft-status、草稿、缺失引用、嵌套来源和长 Unicode。
只有 handler 的 db 模块 mock 指向该 Tx，调用真实 GET Request/Response 做完整 bytes parity；这属于 HTTP handler 测试，不是 live network。
读阶段遍历所有 `pg_tables` 的 public 表，比较全内容 MD5 和 count；真实抛错 rollback 后检查三类 fixture 消失且全 public 表快照恢复。
其余测试覆盖严格 expiry 等于 now 的排除、created_at/id 排序、无 expiry/可选键缺失、actor fallback、空结果、20/50/200、非法0/-1/201/fraction/text以及非目标 action/subject。

父建议 scoped DB 命令为
`pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/note-board-read.db.test.ts src/capabilities/agency/api/notes.db.test.ts src/capabilities/agency/server/notes.db.test.ts`。
作者未运行 DB、Docker、服务、provider、browser、runtime 或 paid calls，也未 push/PR/Linear。
没有新增 actionable follow-up；既有 Start 消费和整体退出义务仍由1358/1359覆盖。
本记录仅建立源码、无 DB unit、静态检查及 bundle 证据；DB、独立 review、exact-head CI、页面/部署验收仍待父完成。

## Source SHA-256

以下为本次最终源码与只读契约的 `shasum -a 256`，路径均在本工作树内：

```text
ff2369b7f3d110e33078afd12b943445f4aee99905fba39ffbffbc7b51f5dc83  src/capabilities/agency/api/notes.ts
96436421a081bada6ec0332607041c5fd1ffbc0f2411dcf9d8e517d2124970c4  src/capabilities/agency/public.ts
afc5e2c2010c5f3bad8bec52be3cf6835b80f7bf4c77acdb34426b17cd5b14e8  src/capabilities/agency/server/note-board-read.ts
48ecf97c70ae455b45e332737d1306e485b51f5d4296d0eb06cd0417ab764591  src/capabilities/agency/server/note-board-read.unit.test.ts
f70012a0810ee668e50799c215c37d7c1c44ac9c47b91be6e73e9d0a8158f6fb  src/capabilities/agency/server/note-board-read.db.test.ts
bc58e2d41f98ec7733ed6c5a8d84d69a8366135cf6f23aed3064fe7e9a5b8050  src/capabilities/agency/server/notes.ts
100e56de412b9182bfa210b6662b2844c24951e9813c98483be34f1597e7d199  src/capabilities/agency/api/contracts.ts
```

## 父级验收，2026-10-09 JST

作者已交1f012c62d并completed/noPending释放writer。父核8份源码与14份日志SHA全部一致，实际独立复跑13unit及3文件22DB（新4、原18）通过。DB使用新Testcontainers与真实pool/Tx，验证外部连接不可见、完整HTTP handler DTO parity、全部public表count/digest读取前后不变、rollback后恢复原快照。此为真实DB和handler验收，不是Start页面或live网络证明。

16:52:40.772995Z原子取锁，16:53:28.070847Z核owner/tokend8d6释放。临时PG/Ryuk退出，原运行集合及四容器ID/image/StartedAt/health、releaseSHA全部不变；无provider/worker/replay/deploy。证据见[evidence/yuk1392/cleanup.json](evidence/yuk1392/cleanup.json)、[DB日志](evidence/yuk1392/parent-db.txt)与[作者检查](evidence/yuk1392/author-checks.json)。独立R1已完成，P0/P1 NONE；exact CI待，1392/1358/1359尚未标完成。

独立R1审查1f012c62d相对5fa9d1891的六文件diff，父核diff SHA-256 `bf09abcb26e619105c8032b643e9ba4ca31bb31c969e50569247b04bbe2912f0`一致。审查实际Today20/board50消费者、输入错误、完整DTO及真实Tx fixture，completed/noPending，无需R2。父另实跑provider-lanes、profile、task-census，全部exit0，日志摘要及SHA见[evidence/yuk1392/parent-audits.json](evidence/yuk1392/parent-audits.json)。
