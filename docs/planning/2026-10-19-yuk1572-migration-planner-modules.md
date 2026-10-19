# YUK-1572 — migration apply 纯规划器按完整决策拆分

2026-10-19，分支 `refactor/yuk-1572-migration-planner-modules`（自 `origin/main` 696449125）。架构深化线切片：1956 行纯历史迁移**规划器** `src/core/migration/apply.ts` 按真实决策归属拆分 —— 不涉及迁移执行、判分、DB 或运行时。

## Owner / 完整操作

`buildMigrationApplyPlan` 的完整操作不变：同一三段 pass（非镜像记录解析 → 锚忠实重建/降级 → judge/answer 镜像继承锚最终裁决）→ rollup + worklists，同输入同 plan 同 id 同 digest。拆分后三个完整决策各归其主：

| 模块 | 行数 | 拥有的完整决策 |
|---|---|---|
| `apply.ts` | 1357 | 确定性写意图装配：record→mapping 行/显式降级、submission 链（issuance/group/submission/evaluations/head）、live draft/pending 恢复信封、rollup/worklists；公开 façade 不变 |
| `revision-registry.ts` | 281 | registry v2 工件形状 + fail-visible 解析 + occurrence/snapshot 绑定裁决（digest 逐一对照 / question_asserted / 漂移与缺证明分支） |
| `snapshot-fidelity.ts` | 411 | 冻结 snapshot 提取（attempt/durable review/pending 三形态）+ snapshot→revision 内容可推导性 + registry 坐标对契约校验 |

## Caller knowledge removed

- 公开面逐字保持：`@/core/migration/apply`（及 `./apply`）的 32 个导出名称/类型/签名经机械 diff 确认 IDENTICAL（re-export 计入）。`src/server/migration/apply.ts`、`scripts/migration-apply.ts`、`rehearsal/orchestrate.ts`、`rehearsal/contract-corpus.ts`、`capabilities/practice/server/judge/evaluate-submission.ts`、全部测试的 import 零改动。
- 迁出的实现不再对装配层外可见：`resolveRegistryBinding`/`groupEntriesByQuestion`/`frozenSnapshotOf`/`snapshotContentViewOf`/`RegistryBindingResolution` 只被 `apply.ts` import，不经 re-export —— registry 与 fidelity 的算法细节对既有消费者零可见性变化。
- `apply.ts` 不再 import `extractAnswerHead` 与四个契约校验器；它只按「绑定裁决 + fidelity 结论」消费两个决策模块。

## 两个真实维护变化（before/after）

1. **registry 工件或绑定规则修订**（新增 `binding_kind`、v3 字段、改 dedup/漂移判定语）：before 在 1956 行 `apply.ts` 内修改，评审须在写意图装配上下文中定位 registry 逻辑；after 只改 `revision-registry.ts`（281 行），`apply.ts` 仅在装配层要消费新字段时才动。
2. **fidelity 规则修订**（新 criterion kind、归一化口径、坐标约束、新增快照形态）：before 校验散落在同文件中段、与降级装配代码相邻；after 只改 `snapshot-fidelity.ts`（411 行），内容可推导性与坐标校验收敛于单一 owner。

## 实际移除的旧职责（apply.ts 不再承担）

- registry 工件解析、逐条形状校验、三类去重/唯一性纪律（seenVerified/seenAsserted/seenExact）
- snapshot digest ↔ snapshot_verified/question_asserted 绑定裁决及判定语文本
- 冻结 snapshot digest 提取（三形态 payload 遍历）
- snapshot 内容面提取与机械比对（题干/选项/参考：text_key、option_set_key、numeric_key）
- 绑定坐标对 revision 契约的普适校验（part⊆、slot 归属、unit 消费槽、契约确定性子集）

## 行为保持（failure/transaction/lock/compat）

- 纯函数模块无 IO/事务/锁；失败模式逐字保留：同 issue detail 文本、同 pending/conflicted/historical_unresolved 分支、同降级写回。
- id/digest 构造（`idOf`/`canonicalHash`/`shortHash`）、迭代与排序次序、`APPLY_ALGORITHM_VERSION`、evidence 键、unresolved reason 文本、worklist 顺序全部不变；无 points 重映射、无 activation、无 FSRS（纪律本就如此，未触碰）。
- 唯一签名变化：`buildMigrationApplyPlan` 内闭包 `resolveAgainstRegistry(qid, digest)` → 模块函数 `resolveRegistryBinding(registryByQuestion, qid, digest)`；返回类型 `Resolution` → `RegistryBindingResolution`（status 收窄为 registry 可产出的 pending/mapped/conflicted 三态；`apply.ts` 私有 `Resolution` 保留含 historical_unresolved 的四态，结构兼容）。
- `EventPayload`/`payloadOf` 在新模块内私有复制 —— 与 `classify.ts` 既有约定一致，不建共享 grab-bag。

## Canonical function-body 比对（源对源 diff，`origin/main:apply.ts` vs 新文件）

- registry 类型/parse/digest（orig 83–266）：IDENTICAL
- resolve 闭包体（orig 1158–1203，去闭包缩进后）：IDENTICAL
- `EventPayload`/`payloadOf`、`verifySnapshotTransformation`/`normalizeReferenceText`/`verifySnapshotReference`/`sameOptionSet`/`validateEntryCoordinates`、SnapshotContentView/normalizeText：IDENTICAL
- `frozenSnapshotOf`/`snapshotContentViewOf`/`groupEntriesByQuestion`：函数体逐字，仅新增 `export`
- 转录事故并已修正复核：`\u0001` 转义一度写成字面控制字符、`typeof raw` 误写 `typeof input` —— 均已修正并经 diff 复核通过。

## 指标 delta（真实）

- `apply.ts` 1956 → 1357 行；新模块 281 + 411 行（均 <1500）。
- 沿用本线源码口径：git tracked 的 src/server/web 下 .ts/.tsx，排除 .test./.spec./.generated.，>1500 文件 **18 → 17**。子任务更宽的全仓口径不混入此指标。
- `pnpm audit:capability-boundaries`：exact 持平 444/0/48；`pnpm audit:architecture-deepening` PASS，SCC 成员与计数不变；新依赖图无环（fidelity→registry 仅 `import type`）。

## 验证与 NOT_RUN

- `pnpm typecheck`（tsc --noEmit + server/start tsconfig）PASS
- `pnpm exec biome check`（三文件）0 诊断；`pnpm lint` 仓库级 exit 0（179 既存 warnings，与本次无关）
- `pnpm build` PASS（web + server/worker/migrate 三 bundle）
- `pnpm audit:capability-boundaries`、`pnpm audit:architecture-deepening` PASS
- **NOT_RUN**：vitest 任何分区（owner 未批准本票测试变更；apply.test.ts 未改未跑，其 import 面经 re-export 逐字保持）、migration CLI、DB、真实 capture、provider/付费、TS↔Rust parity、rehearsal。执行语义与独立复核由父级 review + exact-head CI Gate 承担。

父级复核：源码 `af763a2acf245e3b21c159389440afb2d0c318e0` 的 typecheck、lint（179 warnings）、完整 build 均 exit 0；源树清单确认上述 18→17。原始日志在 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/af763a2acf245e3b21c159389440afb2d0c318e0/parent/`，`checks-sha256.json` SHA-256 `654e0fd8c7608c98fed3cdbc3efc7c932e1fd57a3c59b9dc13cdabd4f8391913`。这是静态/构建证据，迁移运行与真实数据验收仍 NOT_RUN。
