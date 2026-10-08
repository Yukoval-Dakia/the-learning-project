# YUK-1391 — Trait 六操作共享领域出口

基线main `7b89041799881249bbe89344deae8942cc867f70`。沿1358子票查重：1387为读取、1390为subject控制、667为既有HTTP契约，无本slice重复；YUK1391 In Progress。实现和验收均尚待，源码完成不代表管理页或整个迁移完成。

## Ownership

7631独占observability/api/admin-subject-trait-write.ts、api/admin-trait-write.ts、必要server/trait-control-operations.ts、public.ts、scopedtests与本文件。subjects-write-http.ts最多type import；src/server/subjects/trait-write.ts与hydrate.ts只读。Start鉴权、epoch、组合根、消费者由57961995接手。禁止改kernel/manifest/package/lock/UI/config持久化或引入新writer/recovery/idempotency层。

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

唯一实施writer待启动。仅授权作者scoped unit/typecheck/lint/build/audits/Postman；DB由父在实际核验并原子获取部署锁后运行。主线14:52:12Z报告持锁token7109b3c7，当前不得并发runtime。
