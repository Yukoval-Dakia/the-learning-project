# YUK-1391 — Trait 六操作共享领域出口

基线main `7b89041799881249bbe89344deae8942cc867f70`。沿1358子票查重：1387为读取、1390为subject控制、667为既有HTTP契约，无本slice重复；YUK1391 In Progress。六操作共享入口与两个现有HTTP消费者已实现；154 scoped unit与静态/build证据见下。26个新DB案例仅编写，未执行。源码完成不代表管理页或整个迁移完成。

## Ownership

7631独占observability/api/admin-subject-trait-write.ts、api/admin-trait-write.ts、必要server/trait-control-operations.ts、public.ts、scopedtests与本文件。subjects-write-http.ts最多type import；src/server/subjects/trait-write.ts与hydrate.ts只读。Start鉴权、epoch、组合根、消费者由57961995接手。禁止改kernel/manifest/package/lock/UI/config持久化或引入新writer/recovery/idempotency层。父后续仅追加授权收紧scripts/capability-boundary-baseline.json的两个精确值，其余边、豁免与机制不变。

共享入口复用六个原Db自有事务；只在kind=ok且事务提交后await现有hydrate。禁止接受Tx冒充安全发布registry；noop/reject不hydrate，水合失败保留已提交事实与last-good，不自动重试。JSON与Response在HTTP边界，schema/结果通过public共享。

## 验收准备（源码调查，非PASS）

## Contract traps verified from source

- Edit body declarations in trait-write-contracts.ts require strict union payload; actual HTTP edit shells use unknown optional. Keep runtime schema to avoid 400/422 drift.
- Subject edit parses payload before DB existence/CAS. Shared edit loads trait first (unknown404), then payload422, then traitCAS409. Preserve both sequences.
- Fork general forbidden before transaction. Subject-owned fork again returns invalid422, not noop.
- Rebind general forbidden before transaction; subjectCAS before target lookup; same binding returns noop; kind mismatch invalid; fanout issues before writes.
- Rollback checks currentCAS then historical target; same payload noop; otherwise current-schema reparsing and fanout, appends a NEW revision with rolled_back_from target. Never decrement revision or alter lineage.
- Reset-to-seed checks seed lineage beforeCAS; custom fork invalid even with stale revision. Existing seed payload/version noop; changed seed appends reset_to_seed journal and retains bindings.
- HTTP subject edit/fork success use canonical201 for created,200 for existing/noop, with encodeURIComponent(traitId) journal Location. Other four operations omit Location.
- Return full TraitWriteResult including axis/currentRevision/issues, and preserve error mapping.

## Real DB acceptance matrix

Use real pool Db and separate observer connection, not beginTestTransaction/savepoint wrapper. Isolate registry per test. Observe durable effect before hydrated projection.

1. Two custom subjects initially share general charter. Subject edit one COW changes only its binding and registry; source seed/other subject untouched; exact control+trait journals. Repeat equal payload no writes/no hydrate. Owned edit updates same trait, no second fork. Both CAS axes stale reject unchanged.
2. Explicit shared seed edit updates all binders after commit and retains shared ownership; bad assembled payload names affected binders in issues and writes nothing. General owned seed edit legal; general fork/rebind forbidden.
3. Fork creates rev0 source snapshot and subject control revision, readable encoded journal Location; repeat own-fork invalid.
4. Rebind onto valid same-kind target changes control journal and registry; repeat noop; different kind/absent target/stale rejected unchanged.
5. Shared edit then rollback restores payload as NEW revision, preserves original lineage and old journal rows; repeat content noop; missing or incompatible historical target invalid.
6. Modify seed then reset-to-seed performs real kind ok and registry update; unchanged seed noop; custom lineage invalid. No invented header.
7. Inject actual missing-table error only into post-commit hydrate select; existing catch keeps last-good, committed rows/journal stay, one writer/hydrate, no retry. Don't pretend rollback.
8. Compare public operation output and real HTTP handler status/body/Location, including params->JSON->schema order, non-strict extra keys, missing payload, every error variant. No-write snapshots must name their table/sequence coverage rather than claim all DB.

Existing regression files: src/server/subjects/trait-write.db.test.ts, src/capabilities/observability/api/admin-subject-trait-write.db.test.ts, src/server/subjects/hydrate.db.test.ts. Author may run scoped unit/static/build; parent must lock before any DB/container. No UI/Start/manifest/kernel/config changes.


## 当前验证状态

实现者始终是本worktree唯一代码writer，未切branch/worktree，未delegate、push、开PR、改Linear或操作runtime。初始clean HEAD为`e401dcc3d6f2f4d5e48ef77d7d31cc2f8905a47e`，branch为`feat/yuk-1391-trait-control-domain`。父后来报告主线锁已释放，但仍明确禁止作者跑DB；本lane没有运行DB/testcontainers/docker/services/provider/worker/replay/browser。父持有PLAN/.remember/W5文档、独立review、DB与后续delivery。

## 已实现的公共合同

`observability/public.ts`导出下面六个异步操作。所有返回`Promise<TraitWriteResult>`，首参均为显式`Db`，不接受`Tx`。结果联合完整保留`kind`、`axis`、`currentRevision`与fanout `issues`。

| 操作 | 第二参数类型 | 字段 |
|---|---|---|
| `editSubjectTrait` | `EditSubjectTraitInput` | subjectId, kind, expectedSubjectRevision, expectedTraitRevision, payload? |
| `forkSubjectTrait` | `ForkSubjectTraitInput` | subjectId, kind, expectedSubjectRevision |
| `rebindSubjectTrait` | `RebindSubjectTraitInput` | subjectId, kind, targetTraitId, expectedSubjectRevision |
| `editSharedTrait` | `EditSharedTraitInput` | traitId, expectedRevision, payload? |
| `rollbackTrait` | `RollbackTraitInput` | traitId, expectedRevision, targetRevision |
| `resetTraitToSeed` | `ResetTraitToSeedInput` | traitId, expectedRevision |

`payload?`为unknown，由原writer按原顺序验证；缺失payload归领域422。`kind`为既有`SubjectTraitKind`。两个新runtime body schemas为`EditSubjectTraitInputSchema`、`EditSharedTraitInputSchema`，保留非strict对象与`z.unknown().optional()`。其余等价schemas复用原declaration：`AdminSubjectTraitParamsSchema`、`AdminTraitWriteParamsSchema`、`ForkSubjectTraitBodySchema`、`RebindSubjectTraitBodySchema`、`RollbackAdminTraitBodySchema`、`ResetAdminTraitBodySchema`。上述schemas、六个Input类型、`TraitWriteResult`与`FanoutIssue`均由public导出。

公共操作直接调用原`src/server/subjects/trait-write.ts`的六个writer，等待其自有事务返回，只在`kind=ok`后await一次原hydrate。noop/reject没有hydrate；原hydrate的caught failure report与last-good语义保留，没有retry、recovery或新持久化writer。原trait-write.ts/hydrate.ts和HTTP response mapper字节未变。

两个HTTP适配器实际消费共享schemas与操作。params→JSON→schema顺序、原错误文案、status/body均保留。subject PUT/FORK的ok/noop仍经canonicalResourceResponse，ok且forked为201，其他为200，并给encoded trait journal Location。其余四操作没有Location。领域文件没有Request/Response。

## 作者执行的checks

全部命令使用Node `v24.19.0`，PATH前置`/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin`；pnpm `11.13.1`。没有install、依赖变更或full pnpm test。

| 命令 | exit | 完整log与范围 |
|---|---|---|
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/trait-control-operations.unit.test.ts src/capabilities/observability/server/subject-control-operations.unit.test.ts src/subjects/trait-compose.test.ts` | 0 | `/tmp/yuk1391-unit.log`，154 tests / 3 files；新seam/HTTP 75 |
| `pnpm typecheck` | 0 | `/tmp/yuk1391-typecheck.log`，含Start tsconfig；只编译DB测试，未执行 |
| `pnpm lint` | 0 | `/tmp/yuk1391-lint.log`，290既有warnings；task文件scoped Biome无diagnostics |
| `pnpm exec biome check <7 task source/test/baseline files>` | 0 | `/tmp/yuk1391-scoped-biome.log` |
| `pnpm build` | 0 | `/tmp/yuk1391-build.log`，Vite SPA/Start、server/worker/migrate bundles；未启动它们 |
| `pnpm audit:partition` | 0 | `/tmp/yuk1391-audit-partition.log`，unmatched=0、unmocked unit DB import=0；六个既有DB文件warnings |
| `pnpm audit:api-contracts` | 0 | `/tmp/yuk1391-audit-api-contracts.log`，173/173 declared、0 legacy |
| `pnpm audit:api-client` | 0 | `/tmp/yuk1391-audit-api-client.log`，生成后tracked diff为空 |
| `pnpm audit:api-client-usage` | 0 | `/tmp/yuk1391-audit-api-client-usage.log` |
| `pnpm gen:postman` | 0 | `/tmp/yuk1391-postman.log`，33 folders / 87 paths / 94 requests；spec与collection无diff |
| `pnpm audit:capability-boundaries` | 0 | `/tmp/yuk1391-audit-capability-boundaries-final.log`，exact 433/0/48 |
| `pnpm audit:schema` | 1 | `/tmp/yuk1391-audit-schema.log`，893 fields；18既有allowlist entries expected_by=2026-10-08在2026-10-09过期；没有改schema/writer/allowlist |

初始boundary audit exit1记录在`/tmp/yuk1391-audit-capability-boundaries.log`。作者先向父报告`observability -> subjects 9 < 11`、total `433 < 435`；父实读后仅授权精确收紧这两个值。baseline diff只含11→9、435→433，没有其他边/豁免/机制变化。canonical snapshot在`/tmp/yuk1391-audit-capability-boundaries-snapshot.log`。

额外architecture audit的初次log为`/tmp/yuk1391-audit-architecture-deepening.log`，exit1、54 findings，包括generated dist/start provider-wire census与当时未收紧的两项baseline。baseline收紧后的复查另存`/tmp/yuk1391-audit-architecture-deepening-final.log`，exit1、52 findings，均为generated dist/start provider-wire census与其汇总，15 unclassified provider wires；没有boundary findings。不以该audit为绿色声称。没有为这些非本slice findings修改外部owner代码或豁免。

unit log保留Vite configLoader native兼容warning。build保留node:crypto browser externalization、large chunks与review-operation静态/动态import warning，未改其owner代码。没有新增task文件Biome诊断。

## 已编写但尚未执行的DB验收

新`server/trait-control-operations.db.test.ts`有26案例：domain与真实HTTP各六条committed flow、两条no-write parity矩阵、domain与HTTP各六种operation的actual42P01 postcommit hydrate failure。使用real pool Db与独立postgres observer连接，resetDb隔离，没有beginTestTransaction或savepoint shim。成功hydrate之前observer先验证commit可见；之后验证registry。输入包含长中文、嵌套noteTemplate、未知/缺失payload、两CAS轴、幻judge与不兼容历史快照。

具体覆盖COW不改shared seed/其他binder、自有编辑不再fork、shared fanout、general自有编辑与fork/rebind禁令、fork source rev0与可读journal、rebind/noop、rollback新revision与rolled_back_from/血统、reset-to-seed新revision/noop/血统优先于CAS。失败注入只改writerDb顶层hydrate select，让Postgres对不存在relation返回42P01；原catch report、commit可见、registry last-good与一次writer/hydrate断言均保留。没有mock42P01结果或声称DB已PASS。

no-write snapshots明示九表：subject、subject_trait、subject_trait_binding、subject_trait_journal、subject_control_journal、subject_name_claim、knowledge、event、materialized_id_index；另含subject_change_seq的last_value/is_called。它们不声称整个数据库无写。

父接回writer后核验实际锁并执行：

```bash
pnpm vitest run --config vitest.db.config.ts src/capabilities/observability/server/trait-control-operations.db.test.ts src/server/subjects/trait-write.db.test.ts src/capabilities/observability/api/admin-subject-trait-write.db.test.ts src/server/subjects/hydrate.db.test.ts
```

仍需父的独立review、真实DB验收与exact-head CI。Start consumer/boot/composition、产品运行验收与delivery不属于本实现任务。按用户明确禁令没有执行Linear capture；新slice未发现额外产品follow-up，audit外部owner缺口已在本文与父handoff记录，tracker处理由父决定。作者最终提交、SHA256 manifest与check command/exit/log清单将位于`/tmp/yuk1391-*`并在handoff引用。作者在最终clean本地提交后明确释放writer。
