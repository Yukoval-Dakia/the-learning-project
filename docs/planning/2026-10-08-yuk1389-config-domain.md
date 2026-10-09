# YUK-1389 配置公共领域出口

## 范围与现状

基线main d609c7b66。主线明确本线程独占observability配置领域出口，Start鉴权、epoch和canonical facts/writer注入仍由主线负责。1358子票与配置相关票查重后建立YUK-1389；1007继续负责配置产品剩余功能，本slice不关闭整个设置页或迁移。

允许修改api/admin-config.ts、api/admin-config-write.ts、server/config-read-model.ts、server/admin-config-writer.ts的接口/类型、必要同目录typed operation、public.ts及scoped tests。body schemas复用或导出，不改约束。若边界引用实测减少，只按实际计数收紧baseline。禁止Start/boot/index/manifest/package/kernel/配置持久化/subject写入/hydration/UI/runtime。

## 保留契约与验收

复用现有builder、snapshot store和runtime facts，不伪造Db|Tx reader。HTTP JSON解析留适配器；领域操作用原schema并调用现有注入writer。畸形JSON返回invalid_json400；结构无效返回invalid_config_request400；仅合法输入遇未注入writer才503。RESET一次映射clear并单次调用，note与下游错误完整保留。epoch receipt区分提交与快照，snapshot_current不是worker确认。

验证完整读取DTO、已注册key与secret排除、缺少facts真实状态、输入限制和负例、下游错误和无重复writer调用。先Node24 scoped unit/typecheck/lint/build及相关audit；确需DB由父重新核锁协调后验收。独立R1、exact-head CI和合并仍待，不宣称运行或部署通过。

## 实施与证据

公共入口已完成，原 GET/PATCH/RESET 实际消费 `observability/public`。读取直接复导出既有 builder，不新增 selector、Db/Tx 参数或持久化 writer；builder/store/facts 注入源码未修改。领域操作只复用原 body schema 并查找当次注入的 writer。JSON 解析和错误响应整形仍留在 HTTP 适配器。RESET 不去重，原 keys 顺序和重复项一次映射为 clear，由原 writer 裁决。

公共函数签名：

```ts
buildAdminConfigReadModel(
  env: NodeJS.ProcessEnv = process.env,
  facts: AdminConfigRuntimeFacts | null = null,
): AdminConfigReadModel;
patchAdminConfig(input: unknown): Promise<AdminConfigWriteResult>;
resetAdminConfig(input: unknown): Promise<AdminConfigWriteResult>;
```

`AdminConfigWriteInput` / `AdminConfigResetInput` 从原 body schema 推导，`AdminConfigWriteResult` 从原 response schema 推导并继续作为注入 writer 的返回类型；没有新增返回值解析或改变 writer 实现。公共读取类型包括完整 `AdminConfigReadModel`、key/task/value 与原 facts/provider/runtime/schedule 类型，另导出原 HTTP schemas。`snapshot_current` 仍只表示本进程观察到提交或更晚快照，不是 worker ACK。

任务文件共八个：

- `src/capabilities/observability/api/admin-config.ts`
- `src/capabilities/observability/api/admin-config-write.ts`
- `src/capabilities/observability/public.ts`
- `src/capabilities/observability/server/admin-config-writer.ts`
- `src/capabilities/observability/server/admin-config-operations.ts`
- `src/capabilities/observability/server/admin-config-operations.unit.test.ts`
- `src/capabilities/observability/server/config-read-model.unit.test.ts`
- `docs/planning/2026-10-08-yuk1389-config-domain.md`

### 本机验证

全部命令在本树使用 `PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH`，实际 Node v24.19.0 / pnpm 11.13.1。共 176 个不同 scoped unit 用例通过：读取 33、操作及真实 HTTP 适配器 64、既有公共端口回归 79。HTTP 单测直接调用真实 Request/Response handler，不代表 Hono 鉴权或 DB 接受验收。

| 命令 | 结果与日志 |
| --- | --- |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/config-read-model.unit.test.ts src/capabilities/observability/server/admin-config-operations.unit.test.ts` | 首轮 97/97，`/tmp/yuk1389-unit-initial.log` |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/config-read-model.unit.test.ts -t 'public config read builder'` | readonly 断言修正后 4/4、原 29 跳过，`/tmp/yuk1389-unit-read-final.log` |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/admin-config-operations.unit.test.ts` | 最终 PATCH/RESET 独立 receipt fixture 64/64，`/tmp/yuk1389-unit-operations-verified.log` |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/admin-domain-reads.unit.test.ts src/capabilities/observability/server/diagnostics-domain-reads.unit.test.ts src/capabilities/observability/server/event-detail.unit.test.ts src/capabilities/observability/server/today-cost.unit.test.ts` | 79/79，`/tmp/yuk1389-unit-public-regression.log` |
| `pnpm typecheck` | 最终 exit 0，含 Start tsc，`/tmp/yuk1389-typecheck-final.log` |
| `pnpm lint` | exit 0、290 warnings；最终任务七个 TS 文件 Biome 零诊断，`/tmp/yuk1389-lint.log`、`/tmp/yuk1389-biome-final.log` |
| `pnpm build` | exit 0，SPA/Start/server/worker/migrate bundles，`/tmp/yuk1389-build.log`；仅构建，无服务启动 |
| `pnpm audit:schema` | exit 0，`/tmp/yuk1389-audit-schema.log` |
| `pnpm audit:partition` | exit 0，无 unit 未 mock DB 错误、unmatched 0；既有六项 P1 warnings，`/tmp/yuk1389-audit-partition.log` |
| `pnpm audit:api-contracts` | exit 0，173/173、legacy 0、163 paths，`/tmp/yuk1389-audit-api-contracts.log` |
| `pnpm audit:api-client` | exit 0、生成类型无 diff，`/tmp/yuk1389-audit-api-client.log` |
| `pnpm audit:api-client-usage` | exit 0，`/tmp/yuk1389-audit-api-client-usage.log` |
| `pnpm audit:capability-boundaries` | exit 0，精确 435/0/48；baseline 未变化，`/tmp/yuk1389-audit-capability-boundaries.log` |
| `pnpm gen:postman` | exit 0，33 folders/87 paths/94 requests；spec 与 collection 均无 diff，`/tmp/yuk1389-gen-postman.log` |

首轮 typecheck 的 readonly 数组错误已修复，诊断从工具 transcript 保存于 `/tmp/yuk1389-typecheck-initial-failure.log`。调整 receipt fixture 时 hook 曾返回 mock 函数，被 Vitest 当作 cleanup，产生八项失败；原日志 `/tmp/yuk1389-unit-operations-final.log` 保留，hook 改为无返回值后最终 64 项通过。两者均是本 lane 测试代码问题，未掩盖或重试外部写操作。最终只重跑受修改影响的检查。

测试覆盖原 strict schema 的根/子字段、数组 1..256、key 1..200、note <=2000、所有 value 分支和长嵌套对象；无效输入零调用、合法一次、下游 ApiError/未知错误不重试。重复 RESET keys 原样转发给 writer，note 含空白与换行不改写。receipt 保留全部字段及 `snapshot_current=false`，RESET 覆盖 clear 命中与未命中。完整读取 DTO 通过 wire schema；注册键集合、secret canary 排除、无 facts 与每请求 facts 新鲜度均验证。新操作测试未 mock public、schema、builder、store 或注入 writer 的模块实现，只用记录调用的 writer 替代受保护持久化执行；无 Db/Tx 参数伪造。

交接哈希在 `/tmp/yuk1389-task-files.sha256`，全树受保护 tracked 文件对比在 `/tmp/yuk1389-protected-files.json`，原始全树 hash 在 `/tmp/yuk1389-before-tracked-sha256.json`。生成文件与授权八文件外的 tracked 文件必须全部保持起始 HEAD 的字节；提交后工作树须 clean。

### 父验收与边界

只读评估原 `api/admin-config-write.db.test.ts` 与 `api/admin-config.db.test.ts` 后，建议父在核锁后执行这两个 scoped DB suite。写 suite 核 Hono 鉴权先于 writer、未知/secret/pinned key 与 native provider/model 拒绝、重复 PATCH/RESET 全组 rollback、set/reset 的 journal revision 与 epoch 原子性、env pin、hydrate 失败后 receipt 不虚报且不重复提交。读 suite 核真实 DB 写/clear/task override 后的 DTO、boot canonical facts/provider/cron/runtime/effective 值、secret 排除、真实 locale/budget 消费与 reader 差异。新公共入口不能替代这些存储/注入/鉴权证据。

本 lane 未运行 DB/testcontainer/docker、服务、浏览器、provider、worker 或 replay，未触碰 deployment.lock，也未执行 install、完整 `pnpm test`、push/PR/CI/merge/Linear 或他树操作。Start/boot/index/manifest/package/lock/kernel/持久化/subject/hydration/UI 源码与 PLAN/.remember 由父保护。没有新增需另建 issue 的 actionable follow-up；既有 Start 集成和迁移退出继续归 YUK-1358/YUK-1359，父已完成 YUK-1389 查重与建票。

完成本地 task-owned commit 后 writer 释放。父负责独立 review、上述 DB/运行验收、PR/CI/合并与接口交接；本记录不代表设置整页、迁移或部署完成。

### 父实测补充

2026-10-08 exact b107113da父执行原config读写两份scoped DB，48/48通过exit0，日志/tmp/yuk1389-parent-db.log。13:39:27.892078Z原子取得隔离锁，13:40:30.283142Z核owner/token释放；临时PG退出，原运行集合及4容器ID/image/start/status/health、releaseSHA全同。证据/tmp/yuk1389-db-before.json与/tmp/yuk1389-db-cleanup.json。未操作主数据、provider、worker、replay或部署。

随后fetch并正常整合main7682618，仅PLAN/now冲突，保留主线Start/Stop改动和本lane源码。R1只读进行；整合验证及exact-head CI仍待。

整合提交b1450ae4a后，父重新执行6文件176unit、typecheck、lint和build，全部exit0。日志/tmp/yuk1389-integrated-{unit,typecheck,lint,build}.log。55个incoming main文件与main7682618、7个本lane源码/测试与b107113da逐blob相同，证据/tmp/yuk1389-integration-blobs.json。DB48项覆盖的是b107源码；整合未改该源码，CI还须在最终head运行全门禁。R1仍进行，未宣称通过。

### 交付结果

PR1614于2026-10-08 13:54:47Z合入main `0b925feaaf9a7d79c2236835990122958fab5689`，父fetch实核tree `6c602bd9a286e07bdbe989a63c2da800cd73368e`与exact `e1f385f5e`完全一致。CI Gate37786605158全绿；独立R1针对b107源码，P0/P1 NONE，七源码文件在集成后字节一致。reviewThreads为零，bot已终止，按既有规则免等待；CodeRabbit跳过/Codex额度不计代码审查通过。已unwatch、Linear Done并交主线公共接口。未部署，Start消费者及整页退出仍待主线。
