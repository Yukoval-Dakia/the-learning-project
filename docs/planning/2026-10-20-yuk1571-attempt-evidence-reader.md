# YUK-1571 — attempt 证据快照读引擎下沉 `kernel/read-models`（交付记录）

协调线批准的架构深化切片：`question-evidence-snapshot` 完整读引擎（单题自连接 SELECT、Zod 冻结、错误类与失败顺序）从 `practice/server` 整迁至 `src/kernel/read-models`，ingestion 两个消费方直引 kernel。只读搬迁，无 facade 计数、无运行时 registry/DI/新机制。mainline 新 `ingestion/api/operations.ts` 预算门、operation-store/agentrun/ledger 不在本片范围，未触碰。

## Caller 知识前后对照

| 调用方 | Before | After |
|---|---|---|
| `ingestion/api/mistakes.ts` | `loadAttemptQuestionSnapshot` 走 `practice/public`（该文件对 barrel 的唯一 import） | 直接消费 `@/kernel/read-models/question-evidence-snapshot`；不再知 practice public 面 |
| `ingestion/server/enroll.ts` | 同上（该文件对 barrel 的唯一 import） | 同上；调用仍在 import 批次同一 tx 内 |
| `practice/public.ts` | `export { loadAttemptQuestionSnapshot } from './server/question-evidence-snapshot'` | **逐字节不变**：仍经 compat re-export 透出同一符号（#1852 同形） |

## 归属（owner）

- `kernel/read-models/question-evidence-snapshot.ts` — attempt 证据快照**读模型**全部： `QuestionEvidenceSnapshotError`（code: `question_not_found | parent_question_not_found | snapshot_invalid`）、`freezeContext`、`loadQuestionWithAttemptSnapshot`、`loadAttemptQuestionSnapshot`、`DbLike = Db | Tx`。
- `practice/server/question-evidence-snapshot.ts` — 显式 compat re-export（3 个原导出全部保留），供 `practice/public.ts` 兼容面继续工作。

## 所有现有导出比对

| 符号 | before 提供方 | after 提供方 | 变化 |
|---|---|---|---|
| `QuestionEvidenceSnapshotError` | practice/server 本文件 | kernel read-model（经 compat） | 仅归属 |
| `loadQuestionWithAttemptSnapshot` | 同上 | 同上 | 仅归属 |
| `loadAttemptQuestionSnapshot` | 同上 | 同上 | 仅归属 |
| `practice/public` 的 `loadAttemptQuestionSnapshot` 导出 | `./server/question-evidence-snapshot` | 同左（不变） | 无 |

无新增、无删除、无改名导出；`DbLike`、`QuestionEvidenceSnapshotSource`、`parentQuestion` 仍为模块内部符号。

## 两个真实维护场景

1. **冻结上下文字段扩展**（question 表新增需进快照的列，如 rubric/答案键字段）：前后都只改一个读实现（`freezeContext` + schema），改动点数不变。变化是归属：读取事实归 kernel，ingestion 两个入口不再依赖 practice 公共 barrel 即可编译；practice 写侧（判分/FSRS/supply）与读模型不再共享同一文件。
2. **新增第三个跨 capability 消费方**（如 agency 诊断面或 notes 评审面需要同一 attempt 证据快照）：before 必须 `import '@/capabilities/practice/public'`，新增一条跨包读边并须登记 `capability-public-read-cycles.ts` catalog；after 直接 `import '@/kernel/read-models/question-evidence-snapshot'`，不产生跨 capability 边、无需 catalog 登记。没有消除此前不存在的重复实现；调用方仍须理解自己选择的投影。

## 行为保持证据

- `kernel/read-models/question-evidence-snapshot.ts` 与 `origin/main` 版 `practice/server/question-evidence-snapshot.ts` **逐字节一致**（`git show origin/main:<orig> | diff - <new>` → IDENTICAL）。
- 单题自连接 SELECT（`leftJoin parentQuestion` + `getTableColumns` 双侧列）、`.limit(1)`、Zod `safeParse` 冻结、错误类/code/消息文本/失败顺序（question_not_found → parent_question_not_found → snapshot_invalid）零改动。
- `Db | Tx` 签名不变；mistakes/enroll 两处调用仍在原事务内（`db.transaction(async (tx) => …)` / `enrollCapturedBlock(tx, …)`），无字段改动、无坏数据降级。
- 读保持同步单语句；旧报告所称「必需异步/环内计数」不成立，不采信——本引擎本就是调用方 tx 内一条 joined SELECT。
- compat shim 的 3 个 re-export 与原文件导出集完全一致；`practice/public.ts` 第 73 行不变。

## 残留 compat 与退出

- `practice/server/question-evidence-snapshot.ts` 保留显式 re-export shim，live consumer = `practice/public.ts`（唯一存量引用；无包内深层消费方）。
- 退出路径：public barrel 不再透出该符号（或全部消费方直引 kernel）后 shim 可整体删除；不在本片。

## 指标（实测，base=`scripts/capability-boundary-baseline.json`）

| 指标 | base | head | 说明 |
|---|---|---|---|
| cross-capability value edges | 42 | 40 | −2：`ingestion -> practice` 2→0（mistakes.ts + enroll.ts 两边退出） |
| nontrivial SCC | 1×5 cap | 1×5 cap | 不变（agency/ingestion/knowledge/notes/practice 仍在同一环） |
| capability→server | 429 | 429 | 不变 |
| server→capability deep | 0 | 0 | 不变 |
| seam violations | — | 0 | 无新增跨包非 public import |

## 父方所有的预期 delta（本片不改 audit/baseline/CI）

- `pnpm audit:architecture-deepening` 报 4 条，全部预期：2 条 `stale entry`（catalog 中 mistakes.ts/enroll.ts 不再 import practice/public）+ 2 条 baseline debt-decreased（ingestion→practice 2→0、total 42→40）。`scripts/capability-public-read-cycles.ts` 台账修正归父；本片可附注：对应 catalog entry 应按本 head 真实边集退役（同 #1852 对已退边的处理）。
- `pnpm audit:capability-boundaries` 报同 2 条 baseline delta（debt decreased → tighten）。baseline 登记归父，本片不动 `capability-boundary-baseline.json`。
- 新防回退门（如 kernel read-model 消费方向白名单）仅为方案候选，须经 owner 批准后由父实施。

## Commands（本机已跑）

- `pnpm exec biome check <4 changed files>` PASS
- `pnpm typecheck` PASS（两 tsconfig）
- `pnpm lint` PASS（178 warnings，全部既有；未将警告总数当作与 main 逐项等价的证明）
- `pnpm build` PASS（web + server/worker/migrate 三 esbuild 产物）
- `pnpm audit:capability-boundaries` **EXPECTED-FAIL**（2 条 debt-decreased delta，baseline 归父）
- `pnpm audit:architecture-deepening` **EXPECTED-FAIL**（4 条：2 stale catalog + 2 同 baseline delta）
- `pnpm audit:capability-boundaries:snapshot` 实测快照已封存（见外部路径）

## NOT_RUN

本机不跑任何测试套件（无新增/修改/删除及执行）、DB、tsx-eval/合成输入脚本、provider/付费链路、Docker、完整 `pnpm test`。行为验收由 exact-head CI Gate（既有 ingestion/practice 相关测试零改动）与独立审查承担。audit catalog 与 boundary baseline 更新、exact-head CI 归父。

## Revision / 外部路径

- base：`origin/main` 58289c056（worktree `/Users/yuqi/.t3/worktrees/the-learning-project/t3-618ae27e`，无票号分支 `t3/attempt-evidence-reader`；父 checkpoint 线 `t3/question-evidence-snapshot-kernel` 未带入）
- head：以 `git rev-parse HEAD` 为准（本文件随 head 提交，不能自含 SHA）
- 检查日志与实测快照：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/<head>/`
