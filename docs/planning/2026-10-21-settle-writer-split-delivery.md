# 结算写者拆分 — 交付说明（YUK-1643）

状态：已实施；纯搬移，行为与对外签名不变。静态门禁见末节，以 exact-head CI 为准。

- 来源：PR #1893（YUK-439）QA P2。`src/server/assessment/settle.ts` 由 1532 涨到 1610 行，
  越过 1500 行架构门。
- 基座：`origin/main` `102e77e42983155600fa31849d121d8c844b19b0`（同一 commit 即分支起点）。
- 分支：`el/yuk-1643`。本 PR 不改 `PLAN.md` / `.remember/now.md`。

## 拆分结果

按要隐藏的决策拆分，不按调用顺序拆；四个写者文件之间无 import 环。

| 文件 | 行数 | 拥有的决策 |
|---|---:|---|
| `src/server/assessment/settle.ts` | 635 | 两个公开操作（`learningSettlement`、`withdrawCapturedOccurrence`）、只读候选态出口 `candidateStateForRead`、结算回执（`writeSettlementEvent` / `writeReplayRequired`）与 action/version 常量 |
| `src/server/assessment/settle-plan.ts` | 490 | 本次作答意味着什么：封存 scope 加载、plan 推导（subjects / KC 观测 / theta 与标定锚 / forgetting fact），以及 plan 的 subject 与调度效果投影 |
| `src/server/assessment/settle-apply.ts` | 308 | 一个已封存 plan 的落地：FSRS 调度、一次共享 theta 更新、快照 bracket、family/label/calibration 钩子；不再判分、不再推导 |
| `src/server/assessment/settle-replay.ts` | 238 | 撤销与重放安全：拒绝类型、单成员回退（theta/FSRS 段来自各自封存 bracket）、用户评分保留规则、无法归因的新写入检测 |

迁移去向（声明级）：

- `settle-plan.ts`：`QuestionLite`、`SettlementScope`、`normalizeIds`、`contentKcs`、
  `unitPartIdsOf`、`unitExecutorKinds`、`loadScope`、`derivePlan`、`schedulingSubjects`、
  `hasSchedulingEffect`、`planSubjects`、`rederiveSettlementPlan`。
- `settle-apply.ts`：`ApplyOutcome`、`SettlementObservers`、`executePlan`。
- `settle-replay.ts`：`ReplayRequired`、`revertSettlementMember`、`preservedUserRatingExists`、
  `findUnattributedNewerWrites`。
- 留在 `settle.ts`：action/version 常量、`candidateStateForRead`、`writeSettlementEvent`、
  `writeReplayRequired`、`ReplayRequiredError`、`learningSettlement`、`withdrawCapturedOccurrence`。

回执写入没有单独成模块：它只被本文件的两个公开操作消费，抽出后既无独立消费者，也只能靠
转发维持原名，属于为拆分而拆。

## 行为等价证据

用大括号配对从基座 `settle.ts` 提取 25 个声明，与迁移后所在文件逐条比较；归一化仅忽略
前导 `export ` 与空白，25/25 `IDENTICAL`。覆盖上表全部迁出声明，以及留在 `settle.ts` 的
`candidateStateForRead`/`writeSettlementEvent`/`writeReplayRequired`/`learningSettlement`/
`withdrawCapturedOccurrence`/`ReplayRequiredError`。提取脚本与输出未入库，命令见 PR 描述。

公开出口与签名不变：`learningSettlement`、`withdrawCapturedOccurrence`、
`candidateStateForRead`、`ASSESSMENT_SETTLEMENT_ACTION`、`ASSESSMENT_SETTLEMENT_VERSION`
仍在 `settle.ts`。`SettlementObservers` 随 `executePlan` 移到 `settle-apply.ts`；
`src/server/assessment/runtime.ts` 只把它作为 type-only 出口转给既有装配消费者，不新增值转发。

## 边界与基线

- 未新增 `export-from`、registry、shim、allowlist 或纯转发包装；pass-through 扫描新增 0。
- 未改 `scripts/capability-boundary-baseline.json`：审计实测新依赖边 0，债务 totals 不变
  （387/0/36），SCC 1 个（base 1）。
- 新增文件均 <1000 行，不触发 `sourceSizeRecords`；`>1500` 文件 11（base 12）。
- 跨模块调用仍只走既有 `public`/kernel 端口。`writeAttemptSnapshotBrackets` 与
  `SYNTHETIC_SUBJECT_ROOT_RE` 的 import 随代码分别落到 `settle-apply.ts` 与
  `settle-plan.ts`；这是 server→capability-public 的 report-only 文件端点变化，不改变
  capability 级依赖，也不进入债务 ratchet。

## 本机实跑 / NOT_RUN

实跑（Node 22.23.3，pnpm 11.13.1，仓库 `pnpm` 报 engine 警告但不影响结果）：

- `pnpm typecheck` rc=0
- `pnpm lint` rc=0（182 个既有 warnings，改动文件 0 warning）
- `pnpm build` rc=0
- `pnpm audit:capability-boundaries` rc=0：new dependency edges=0，totals 387/0/36，
  SCC 1（base 1），`>1500` 11（base 12）
- `pnpm audit:architecture-deepening` rc=0：pass-through +0 new
- `pnpm audit:schema` / `question-writers` / `api-contracts` / `api-client-usage` / `tool-params` /
  `profile` / `learner-copy` / `no-learning-styles` / `structured-judge` / `task-census` /
  `draft-status` / `draft-status-reads --strict` / `flags --strict` / `hub-sync-writers` /
  `provider-attempt-truth` / `model-source` / `partition` / `test-policy` 均 rc=0
- `audit:api-client`：pnpm engine 警告写入 stdout，污染 `gen:openapi` 的 JSON 管道（环境问题）。
  直接跑 `tsx scripts/generate-openapi.ts` + `node tools/api-codegen/generate.mjs` 后
  `git diff --exit-code` 为 0，生成物无漂移。

NOT_RUN：`pnpm audit:calibration`（需要 `DATABASE_URL`，本机不碰凭据/env）、全部
vitest/DB/migration、完整 `pnpm test`、真实 provider 与运行时。未新增或修改测试代码。
