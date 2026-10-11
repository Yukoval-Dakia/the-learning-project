# YUK-1355 收据族迁移参考实现：note_verify（Lane B / receipt-reference）

状态：参考实现设计 + 实施。基线 `6f1f3e07`，工作树 `tlp-migration-receipt-reference`，分支 `feat/yuk-1355-receipt-reference`。
本文是该 lane 的接口/所有权设计与交付记录；11 个收据族中只做 note_verify 这一个参考，**父级接受前不复刻任何其他族**。

## 1. 目标与不变量

把 `note_verify` 的执行边界提取为族内可复用 operation，保留 pg-boss handler 作为真实消费者；新增一个有界 DBOS 族适配器作为**显式迁移候选**（不接入运行时）。全程：

- §9 前 AI 能力不动，无删除/降级。
- 未知付费效果绝不自动重放；不新增 provider retry/fallback。
- 既有家族策略保持权威：reserve / provider-started / staged-result / finalize / superseded / ambiguous / per-epoch attempt 预算全部复用现有实现，不复制第二套。
- 生产者身份与已入队 payload 不变：queue 名 `note_verify`、payload `{ artifact_id }`、deterministic job id（`note-handoff.ts` 的 singleton send + readback）全部原样。
- 默认仍是 pg-boss，直到父级做串行注册与证明。

## 2. 所有权矩阵

| 文件 | 归属 | 动作 |
| --- | --- | --- |
| `src/capabilities/notes/server/note-verify-durable-operation.ts` | 本 lane（新增） | 族内可复用执行边界 |
| `src/capabilities/notes/jobs/note_verify.ts` | 本 lane（修改） | 保留的 pg-boss 消费者，改为调用/再导出 operation |
| `src/server/durable/note-verify-family.ts` | 本 lane（新增） | 有界 DBOS 族适配器（迁移候选，无人 import） |
| `src/server/durable/note-verify-family.test.ts` | 本 lane（新增） | 离线单测（unit config，运行） |
| `src/capabilities/notes/server/note-verify-durable-operation.db.test.ts` | 本 lane（新增） | DB 测试（**只准备不运行**） |
| `vitest.shared.ts` | 共享（YUK-1401 允许列表） | 仅追加上述两个测试文件各一行 |
| note-verification-claim* / lifecycle / handoff / refine 域 | 只读 | 不修改 |
| note 产品安全 / prompt / body contracts | 只读 | 不涉及 |
| 共享 DBOS 注册/boot/manifest/schema index/migration SQL/公共 barrel/Start shell/cutover/restore/smoke | 父级 | 本 lane 不碰 |

## 3. 接口设计

### 3.1 执行边界（operation，无后端依赖）

`src/capabilities/notes/server/note-verify-durable-operation.ts`，从 `jobs/note_verify.ts` **原样搬移**（无逻辑改动）：

```ts
export type RunTaskFn = TaskTextRunFn;                       // 注入，模块内不做任何 runner 装配
export interface RunNoteVerifyParams { db: Db; artifactId: string; runTaskFn: RunTaskFn }
export interface RunNoteVerifyResult { status: 'verified' | 'needs_review' | `skipped:${...}`; artifact_type?: string; issues_count?: number }
export function noteVerificationRetryRequired(artifactId: string, reason: string): Error
export function noteBodyBlockContractFailure(artifactType: string, bodyBlocks: unknown): NoteVerificationResultT | null
export async function runNoteVerify(params: RunNoteVerifyParams): Promise<RunNoteVerifyResult>
export async function finalizeStagedNoteVerification(db: Db, artifactId: string, artifactType: string): Promise<RunNoteVerifyResult>
```

- `runNoteVerify` = 单 artifact 一次完整验证执行：reserve → load input → contract-failure 快路径 或 provider 路径（`beforeProviderQuery` 处原子 `markNoteVerificationProviderStarted`）→ stage → finalize。
- `finalizeStagedNoteVerification`（原模块内 `finalizeStagedVerification` 改名导出）：result_ready 恢复再入的共享收口，pg-boss 恢复 floor 与未来 DBOS 重放共用。
- 模块不 import pg-boss、DBOS、`makeRunTaskFn`——runTaskFn 永远由调用方注入。

### 3.2 保留的 pg-boss 消费者

`jobs/note_verify.ts` 保留：`NoteVerifyJobData`（shape 不变）、`buildNoteVerifyHandler`（默认 `makeRunTaskFn(db)` 的装配留在此层）、`recoverResultReadyNoteVerifications`（`hub_sync_recovery` floor 的消费面，经 dynamic import 调用，签名不变）。`runNoteVerify`/`noteBodyBlockContractFailure`/相关类型自 operation 再导出，`note_verify.db.test.ts` 与 manifest 的既有 import 面不变。

### 3.3 有界 DBOS 族适配器（迁移候选）

`src/server/durable/note-verify-family.ts`，沿用 `review-orphan-worker.ts` + producer-fence 模板的最小子集：

```ts
export const NOTE_VERIFY_FAMILY = 'note_verify';
export const NOTE_VERIFY_STEP_NAME = 'note-verify-v1';
export const noteVerifyWorkflowInputSchema = z.object({ artifact_id: z.string().min(1) });  // 与 NoteVerifyJobData 同形
export type NoteVerifyRunStepFn = <T>(fn: () => Promise<T>, config?: StepConfig & { name?: string }) => Promise<T>;
export async function runNoteVerifyWorkflowBody(deps, runStep, workflowId, rawInput): Promise<RunNoteVerifyResult>
export function registerNoteVerifyWorkflow(deps: { db: Db; runTaskFn: RunTaskFn })
```

- workflow body 是纯函数：校验 durable workflow identity → 解析 payload（与已入队 payload 同形）→ 在 `runStep(..., { name: NOTE_VERIFY_STEP_NAME, retriesAllowed: false })` 内调用 operation，结果原样返回。
- `registerNoteVerifyWorkflow` 用 `DBOS.runStep` 装配 body 并注册 workflow（`name: NOTE_VERIFY_FAMILY`）；**运行时无人 import 本模块**——串行注册、launch、queue、phase/fence 机制全部父级所有。
- 后端各自的错误映射不进 operation：pg-boss handler 保持现有 `skipped:in_progress|ambiguous → throw retry-required`；DBOS host（父级）自行决定 workflow 结果的 disposition。适配器只透传结果，**不复制策略**。

## 4. DBOS 恢复不回购 claim（no-repurchase 合同）

DBOS step 结果丢失后重放时，重入的仍是 `runNoteVerify` 的 reserve 前置，claim 状态机决定行为：

| 恢复时的 claim 状态 | reserve 结果 | 行为 |
| --- | --- | --- |
| `provider_started`，lease 未过期 | `busy` → `skipped:in_progress` | 不再调用 runTaskFn；workflow 以 SUCCESS 返回 `skipped:in_progress`。host 必须按业务结果保留待完成义务，不能仅按 workflow 状态判断完成 |
| `provider_started`，lease 已过期 | 转 `ambiguous` → `skipped:ambiguous` | 终态化，不补一次付费调用 |
| `result_ready` | `result_ready` | 走 `finalizeStagedNoteVerification` 收口，不调 runTaskFn |
| `retry_wait`（显式 release 后） | 重新 reserve | 合法新 attempt，`provider_attempts` 在共享 claim 行上继续计数至 per-epoch 上限 3 |

`retriesAllowed: false` 禁止自动 step 重试，但不阻止崩溃恢复重新执行 step 函数。防止重复付费依赖 `runNoteVerify` 的 reserve 前置与持久化 claim 状态；固定 step 名不是付费去重证明。provider_started/result_ready 的恢复重入不会发起新调用，未知结果仍交由人工/父级恢复策略处置。

## 5. 缺失共享原语检查（blocker 评估）

现有 `note_verification_claim` 提供 fence/token/epoch/attempt 预算，足以支持本次执行边界提取。候选适配器尚不能作为已完成的任务族迁移：以下父级集成与验收门槛仍未完成。

1. 生产侧派发的 DBOS 变体（`note-handoff.ts` 目前 `boss.send('note_verify', …)`）——cutover 时需父级加 DBOS enqueue 或保留 pg-boss 派发 + 双端消费裁决；
2. 串行注册与共享 lifecycle（`register-capability-jobs.ts` 只准入既有族）；
3. phase/fence/退出排空机制（参照 review_orphan_control 模式）；
4. 对 `skipped:in_progress`、`skipped:ambiguous` 及其他业务结果逐项定义待完成义务查询与处置。SUCCESS workflow 不等于业务完成；未完成/未知效果必须保持可见且不得自动重购。

## 6. 测试

- **离线单测（运行）** `note-verify-family.test.ts`：durable identity 必需；payload 与已入队契约同形（拒绝 camelCase/空值）；step 名固定且 `retriesAllowed:false`；结果透传。每例 `@invariant/@fails-if`。
- **DB 测试（只准备不运行）** `note-verify-durable-operation.db.test.ts`：恢复重入 provider_started（未过期→busy 不重购 / 已过期→ambiguous 不重购）；result_ready 恢复 finalize 且恰好一次；retry_wait 新 attempt 共享 per-epoch 预算。直接操纵 claim 行模拟崩溃后状态，不 mock 语义本身。
- 两个文件分别加入 `fastTestInclude` / `dbTestInclude`（YUK-1401 显式指派）。

## 7. 验证与交付

离线检查：scoped unit test、`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:test-policy`（本 lane base）。本地 commit 仅含 owned 文件 + vitest.shared.ts 两行追加。运行时缺口（DB 测试未跑、DBOS 未注册、CI 未跑）如实报告，独立 review 与 exact-head CI 由父级按 PR 负责。

## 8. Independent review result

R1 on `a62d0fde1` found no code P0/P1 and one consequential documentation error: the adapter returns SUCCESS with `skipped:in_progress`, rather than ERROR. Parent corrected the result disposition and claim-based recovery guarantee in docs-only `ca41cb633`.

The first GLM R2 request failed on quota and returned no review findings. The same bounded R2 resumed with Codex Sol 6.1 and verified `ca41cb633` against `a62d0fde1`: prior P1 resolved, remaining P0/P1 NONE within that scope. This completes the two-round review budget; no third review is authorized.

Parent independently ran the four scoped adapter unit cases successfully before the documentation correction (`/tmp/yuk1355-receipt-parent-unit.log`). DB tests, DBOS registration, business-obligation disposition, runtime recovery and exact-head CI remain pending. This checkpoint is not a completed task-family migration.
