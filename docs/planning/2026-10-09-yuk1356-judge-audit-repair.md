# YUK-1356 judge audit repair

两项实际失败均已修复：capability boundary audit 与 schema write audit exit 0。基线只降，judge 原业务、恢复、付费重试、receipt 与 fence 语义保留。本报告是 implementation writer 的源码/unit/static/build 交接；DB、迁移执行、真实进程与 runtime 验收仍由父承担。

起点为 `feat/yuk-1356-durable-judge` / `e2fcaae9d556c7563d666ae5f470a40257b7ee43`，正常整合 main `7472f4395f4a12a5167e33034d5d8af8bf695049`。原实现为 `caa125504c04d6efcbd27e864a958bafeb303ddb`。本 writer 遵守 `/tmp/yuk1358-judge-audit-ownership-20261009.json` 的精确授权，未派子任务。

## 领域归属与 ratchet

`src/server/durable/judge-client.ts` 收敛至 `practice/server/judge-engine-client.ts`。practice 的 DBOS/legacy engine 客户端拥有固定身份、发送、观察、未知态与完整 engine census。dispatch 保留预算、授权、家族/运行锁、receipt 及拒绝/未知 acknowledgment 裁决；其 legacy send 通过 engine 客户端执行。原 dispatch 的 `boss/client` 直接 import 被移除，新 engine 的该 import 接替它，两者的 legacy 查询职责不再分散。dispatch 仍保留已有 `boss/job-observation` 的兼容查询。

这不是只移动文件：operational 身份构造、dispatch 实际发送、status 只读观察、reconcile、operator inventory 和 shared worker 注册的真实消费者全部接同一 practice engine。durable family/worker 与外部 operator fixture 从 `practice/public.ts` 消费真实静态出口；practice 内部消费者经内部 import。未新增动态 import 或 generic 子系统。

实际 capability→server 总数 **434→430**；practice→durable **4→0**，消除 operational、dispatch、observation、reconcile 对 shared durable 层的四条反向依赖。practice→boss **15→15**。durable→practice public **2→2**，全 server→capability public **49→49**；server→capability deep **0→0**，cross-capability value **48→48**，既有 SCC 未变。

已实现的通知收敛令 practice→events 实际为1。原实现前四条生产边位于 assessment/durable-attempt、judge_run、judge_pending_reconcile、status route；现在只剩 judge-run-notification→events/writer。基线只将这项 **4→1**，总数 **433→430**；practice→durable 的 baseline 保持0，boss 保持15。所有类别、每个 owner pair 都验证只降不升，无抵消或 allowlist。原注释及其它基线字节保持。

`source-contract-check.json` 对十个调用者/host/test 文件剔除 import 后比较完整 AST，均与起点一致；原 engine 全部声明/函数也一致，仅 legacy queue 使用已有常量，并新增实际发送函数。新 engine 静态 value 依赖遍历162模块，未出现回到自身的循环。该检查不替代独立 review 或 runtime。

## 0118 初始化合同与负例

审计绑定实际 `src/db/schema.ts` 的唯一 exported `judge_run_control` 完整 Drizzle 声明：字段名/类型、非空、singleton PK/check、epoch mode/check、phase domain、timezone 与 transition 列都必须匹配。不存在表/字段也产生 contract issue，不能因普通字段扫描没找到就通过。

journal 必须是 PostgreSQL/version7，idx118/tag0118唯一匹配，entry version7、when1791504000002、breakpoints=true。首个 executable batch 必须是精确建表与唯一 seed：id1、`gen_random_uuid()`、epoch0、pg-boss、`clock_timestamp()`、null transition。只为 incarnation 提供 init-only 证据，`insert_files=0`、`update_files=0`；没有冒称生产 insert。后续0118批次使用固定 normalized SHA-256 `2ba58ae37dc6b8b12d4e21cfd53966b5af8cb34b920bad221bb88d4a874adc55` 绑定现有 index/receipt/fence SQL，追加改 incarnation 或替换 control 行会拒绝。没有通用 migration/SQL 扫描。

生产 control INSERT 与 incarnation/id UPDATE 独立拒绝，即使存在合法 seed，也不能借 runtime writer 变成 live。UPDATE 仅允许明确普通属性的 epoch、phase、phase_changed_at、transition_event_id；opaque/spread/computed/getter patch 拒绝。真实 judge-family operator 更新仍通过。契约 violations 无法被普通 stub allowlist 消除。

新增 **75项**合同测试：72反例与3正例。完整可机器读取矩阵为 `/tmp/yuk1356-audit-repair/negative-matrix.json`：

- 注册/存在性16项：缺 migration/journal/schema，错误或无关SQL，JSON/entries/tag/idx/version/dialect/time/breakpoint错误，重复或碰撞注册。
- SQL26项：缺/后移/错表/错id/重复seed，固定/错generator/null UUID，epoch/backend/time/transition/type/nullability/default/check/domain错误；注释、函数、未执行DO、字符串伪造；后续incarnation改写或删行重种。
- Drizzle19项：export/SQL/property/column名，类型、非空、default、id PK、epoch type/mode、timezone、check/domain、opaque/comment/local/duplicate声明。
- 生产写11项：Drizzle/SQL UPDATE与INSERT、upsert、opaque/spread/id/computed/computed literal/getter UPDATE。

0117实现合同和全部41测试保留。其 duplicate-registration fixture 原先复制 journal 最后一项，0118加入后误复制118；修复为明确选择idx117，先复现失败，再验证真实117重复仍拒绝。未缩减反例。

## 修改文件

- `scripts/audit-schema-writes.ts`
- `scripts/audit-schema-writes.test.ts`
- `scripts/schema-migration-initialization.unit.test.ts`
- `scripts/capability-boundary-baseline.json`
- `src/server/durable/judge-client.ts`
- `src/capabilities/practice/server/judge-engine-client.ts`
- `src/capabilities/practice/server/judge-engine-client.unit.test.ts`
- `src/capabilities/practice/server/judge-run-dispatch.ts`
- `src/capabilities/practice/server/judge-run-observation.ts`
- `src/capabilities/practice/server/judge-operational.ts`
- `src/capabilities/practice/jobs/judge_pending_reconcile.ts`
- `src/capabilities/practice/public.ts`
- `src/server/durable/judge-family.ts`
- `src/server/durable/judge-worker.ts`
- `src/capabilities/practice/jobs/judge_pending_reconcile.db.test.ts`
- `src/capabilities/practice/api/judge-run-status-route.db.test.ts`
- `src/capabilities/practice/server/native-durable-attempt.db.test.ts`
- `tests/dbos-judge/support.ts`
- `tests/dbos-judge/cutover.db.test.ts`

另创建本修复专属报告。完整精确diff为 `/tmp/yuk1356-audit-repair/repair.patch`；`changed-files.txt` 与 `sources.sha256.json` 覆盖新增、删除、修改路径及hash。parent 的 PLAN/.remember/交付文档、schema/0118/journal、Start配置、package/lock及原sealed manifest保持原样，验证见 `readonly-preserved.json`。

## 验证与封存

PATH使用Node24.19.0，pnpm11.13.1。12文件 scoped unit 首轮334通过；收紧 computed/getter 后仅受影响的5个schema文件重跑239通过，另外7文件98项源码未变，engine29项也在补齐fixture后单独重跑通过。合计337个不同 scoped 用例，依据分区日志，未冒称一次337项 aggregate。root/Start typecheck、全仓lint（287既有warnings）、完整web/Start/server/worker/migrate build均exit0。最后一次源码改动仅audit/test；应用bundle inputs与已通过build的封存hash相同。

最终验证命令的完整 argv、起止、exit code、log hash 在 `commands.json`。关键日志如下（均exit0）：

- `unit-final.log` — SHA-256 `da1213878d78bf4bb8265d6cdaa01742d9edd099b0f39f2c2dfa5ff2241e9930`。
- `schema-tests-immutable-final.log` — SHA-256 `44dc304b39caeb9315ab5e9680eae20d30b6f98e601b6f55152df1d991470e1c`。
- `engine-tests-final.log` — SHA-256 `1544a2e020b1463a5d7894cba17b488640753f3d73c75834d636935108c9ded6`。
- `typecheck-release.log` — SHA-256 `36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6`。
- `lint-release.log` — SHA-256 `4c12710c61f94b37b7158ec0762165be4c85396849bb57ef60f53a8af715160a`。
- `build-final.log` — SHA-256 `37b21b7e1192c9bc4a99395127ce3f354c97f430ec235912a333921276692c3f`。
- `capability-postbuild.log` — SHA-256 `200c97afa183ac56dd5d533093a6ad0663125ba5f9ae619762b3731e81ef54f6`。
- `schema-release.log` — SHA-256 `32d2001fc2cd41387e536a59ee05bb8fdb17fbeed2740571c48b2d6368cdd4d4`。
- `source-contract-check.log` — SHA-256 `8313e886bdaf5db5bc0a024d6d092eecaab178be77b688daad7420e5dc5ea2bb`。

所有失败保留：修复前两项audit；0117 duplicate反例；seam修复后尚未收紧events baseline的audit；新legacy测试缺submitted_at导致的首次typecheck。未覆盖或删除失败日志。

原877产物全hash核对；工作树内874产物在build前复制至新目录 `previous-products/`，另3项本就位于原/tmp目录。原 `HANDOFF.md`、`commands.json`、`products.sha256.json`、`SHA256SUMS` 均未改。新build产生884文件，全部复制到新 `products/` 并逐一hash比较，详见 `products.sha256.json`。关键新产物：

- `dist/migrate.cjs` — `5c71fd787035291a509519d052db2cc0da9a1f41338b1d826ffe1bfd73ca7885`。
- `dist/server.cjs` — `6c5e9819e7e1b7d4bcfb93afde170f1cdc40b5d95c47db943abaec64777cc840`。
- `dist/start/server/server.js` — `449b92e230403d5acf53650fa38cf3666eb04af65948617ca04bca19352a0bf3`。
- `dist/worker.cjs` — `81eedebe6800b94ed49bdc3fc81fa67c0415027549f3dffee4d1bac7b785c2fd`。

`HANDOFF.md` / `handoff.json` 记录最终commit与writer释放；`SHA256SUMS` 封存报告、source/artifact/log manifests、diff和command receipts。source manifest最终与commit blob/本地字节逐一复核。

## 未运行与父接续

DB / Testcontainers / Docker / migrator / process children / 服务 / provider / browser / runtime / 独立review / push / PR / exact-head CI 全部 **UNRUN**。模型unit只使用stub fetch；engine unit只使用mock SDK/boss，没有网络socket。没有安装、依赖/锁变更、runtime锁、分支切换/merge、tracker或其它线程操作。生产entrypoint仅build，未执行。

未发现本范围外需扩权的 actionable follow-up；0117 fixture缺陷已在本次修复。Linear capture及PLAN/.remember交付同步遵守父独占与本任务禁用要求，交回父处理。父下一步为独立review与授权锁下DB/迁移/进程验收；本报告不宣称judge或整个迁移已验收完成。
