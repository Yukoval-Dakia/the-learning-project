# 当前 handoff — 2026-08-02 Architecture Deepening FULL / YUK-841

## Owner direction and tracker

- Owner 明确：「直接启动 FULL」；补充硬约束：「gate 不要在本地跑」。
- Linear project：`Architecture Deepening FULL — 语义、成本与运行所有权`（In Progress）。
- F0 milestone `Truth, contracts, ratchets`：
  - YUK-840 Done：PR #1155 merged，main `24add632`；
  - YUK-841 In Progress：AI attempt 单一成本真相；
  - YUK-842 Todo / blocked by YUK-841：跨进程 provider-lane admission。

## Active checkout

- worktree：`/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-841-attempt-cost-truth`
- branch：`codex/yuk-841-attempt-cost-truth`
- base：`origin/main@24add632b8941d0e4ebfeddb337761e7a1e38c29`
- 原 checkout 与 YUK-840 worktree 均未触碰。

## YUK-841 implementation

- `attempt-cost.ts` 定义唯一 `AttemptCostTruth`：
  - Anthropic direct finite nonnegative SDK value（含 0）→ reported；
  - Xiaomi 0/undefined + known versioned pricebook → estimated；unknown model → unknown；
  - subscription lane → estimated 0 + explicit contract ref；
  - no terminal → unknown，绝不以 0 代替。
- 三个 runner API 背后的四个 terminal interpreter 都在任何 SDK result 上先记录 usage/cost，再做
  success/error 分类；`SDKResultError`、success+is_error、no-terminal 都有 terminal attempt ledger。
- `RunTaskResult` 保持 `cost_usd?: number`，追加必需 basis/ref；unknown result 为 undefined。
- `writeAiTaskAttemptFinished` 在 transaction 内以 `id + status=running` 更新 run，用 RETURNING 的
  task/provider/model 插入唯一 `entry_kind=attempt` ledger；ledger fault 回滚 run update。
- start row 写失败 fail-closed，不获取 provider 成本；stuck-run reconcile 复用同一 atomic finalizer，
  落 failure + unknown attempt ledger。
- migration `0087_yuk841_attempt_cost_truth.sql`：ledger cost nullable、legacy/attempt discriminator、
  basis/ref checks、attempt partial unique；历史行只默认 legacy，不做来源推断。
- admin run/detail/cost 与 `/api/cost/today` 暴露 nullable amount、basis/ref、reported/estimated/legacy
  breakdown、unknown/legacy counts；classified unknown 不再从 legacy correlation row fallback 成 0。
- Postman inventory/collection 与 generated API client 已由仓库生成器同步；本票未写 UI。

## Validation boundary

- Owner 约束后，本轮没有运行任何本地 test/typecheck/lint/build/audit gate。
- 只执行了静态只读检查、仓库 generator 与 Biome formatter；这些不是验证证据。
- 三路独立 reviewer 已对当前真实 diff 完成 runtime、DB/API、consumer/test 只读审查；均无未解决
  P0/P1，P2/minor advisory。
- 完整 migration/unit/DB/typecheck/lint/build/audit 验证必须在 commit/push 后由 exact-head GitHub CI
  执行；CI 未绿前不得宣称 YUK-841 已交付。

## Still required

1. 提交并推送，开 PR。
2. exact-head GitHub CI 全绿、无未解决 P0/P1 后 merge；Linear YUK-841 → Done。
3. 从合并 main 新建独立 worktree 启动 YUK-842；不要与 YUK-841 共享 schema/runtime 并行。

## Explicit non-goals / debt

- 真实合同价格校准仍开放；placeholder estimate 不可用于预算可信声明。
- UI null 展示与产品 operation 级 `cost_usd ?? 0` 聚合不在 YUK-841；本票只闭合 model-attempt truth。
- OCR/GLM、failure-correlation、image-correlation 等非 central runner ledger 保持 legacy，不能冒充已迁移。
- YUK-832–836 保持 open/PARKED；YUK-596 transport 已交付但内容质量 HOLD。
