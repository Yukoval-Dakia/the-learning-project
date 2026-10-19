# YUK-1571 LIGHT — 共享读模型下沉 `kernel/read-models`（交付记录）

设计稿：`docs/planning/2026-10-19-yuk1571-integrated-operation-cuts.md` §L（L1/L2/L3 三操作合成本单 PR；只读搬迁，无运行时 registry/DI/新机制）。

## Caller 知识前后对照

| 调用方 | Before | After |
|---|---|---|
| `knowledge/server/review.ts` | `readAgentNotes` 走 `agency/public` | 直接消费 `@/kernel/read-models/agent-note-hints`；不再知 agency public 面 |
| `knowledge/server/node-page.ts` | 8 个投影符号走 `notes/public` | 直接消费 `kernel/read-models/{notes-read,artifact-backlinks,artifact-corrections}`；不再知 notes public 面 |
| `agency/server/scout/evidence-mcp.ts` | `notesForKnowledge` 走 `notes/public` | 直接消费 `kernel/read-models/notes-read`（`readAgentNotes` 仍走同包 `../notes` 兼容 re-export） |
| `agency/server/tools/learning-item-context.ts` | `bodyBlockSummaries/excerpt/knowledgeContext` 走 `ingestion/public` | 直接消费 `kernel/read-models/extraction-summary` |
| `practice/server/tools/question-context.ts` | 同上 | 同上 |
| `ingestion/server/tools/get-record-context.ts` | `./record-tool-support` 本模块 | 直接消费 `kernel/read-models/extraction-summary` |

## 归属（owner）

- `kernel/read-models/agent-note-hints.ts` — agent-note 提示信道**读模型**（readAgentNotes / readAllAgentNotes / rowToAgentNote + AgentNote*/ReadAgentNotesOpts 类型）。agency 保留写侧（writeAgentNote、recordQuestionPoolGap）与 board 投影（readAgentNoteBoardRows）。
- `kernel/read-models/notes-read.ts` — 按知识标签的笔记/互动 artifact 列表与 notesForItem 投影（原 `notes/server/notes-read.ts` 整迁）。
- `kernel/read-models/artifact-backlinks.ts` — `artifact_block_ref` 反链读 + 代表 owner 解析（原 `block-refs.ts` 读半）。`syncBlockRefsForArtifact`/`desiredCrossLinkRefs` 写机制留在 `notes/server/block-refs.ts`。
- `kernel/read-models/artifact-corrections.ts` — artifact 维度纠错投影（原 `notes/server/artifact-corrections.ts` 整迁）。
- `kernel/read-models/extraction-summary.ts` — 工具上下文的抽取块摘要 + 可见知识路径 + 谓词构造器（原 `ingestion/server/tools/record-tool-support.ts` 整迁）。

## 两个真实变更场景

1. **改过期/目标代理语义**（如收紧 expires_at 判定）：Before 需同时核对 agency 读实现与 knowledge 评审注入是否分叉；After 改 `agent-note-hints.ts` 单点，review.ts 与 agency 全部消费方（经 compat）同时生效。
2. **摘要截断或可见性规则调整**（EXCERPT_MAX / learnerVisibleKnowledgeIds 过滤）：Before 需检查 agency/practice 两个能力对 ingestion 读的复制解释是否一致；After 改 `extraction-summary.ts` 单点，三消费方同时生效。

## 行为保持证据

- `kernel/read-models/{notes-read,artifact-corrections,extraction-summary}.ts` 与原文件逐字节一致（`git show HEAD:<orig> | diff - <new>` → IDENTICAL）。
- `agent-note-hints.ts`、`artifact-backlinks.ts` 的全部搬迁区间（类型、注释、函数体、SQL）与原文件逐字节一致（python difflib 按行区间对比 → IDENTICAL）。
- 排序/limit/期限/可见性/父链/null/异常与 SQL 语义零改动；全部纯读，无锁。

## 残留 compat 与退出

- `agency/server/notes.ts`、`notes/server/{notes-read,block-refs,artifact-corrections}.ts`、`ingestion/server/tools/record-tool-support.ts` 保留显式 re-export shim，供包内消费方与各自 `public.ts` 兼容面继续工作（零改动）。`ingestion/server/tools/query-records.ts` 仍经 compat 导入（未在本批点名范围）。
- 退出路径：compat shim 在全部包内消费方迁到 kernel 后可整体删除；不在本 PR。

## 指标（实测，base=origin/main baseline）

| 指标 | base | head | 说明 |
|---|---|---|---|
| cross-capability value edges | 48 | 43 | −5：K→A 2→1、K→N 1→0、A→N 3→2（evidence-mcp，设计算术漏算的第五条）、A→I 1→0、P→I 2→1 |
| nontrivial SCC | 1×5 cap | 1×5 cap | 不变（N 经 N→K→A→N 仍在环） |
| capability→server | 444 | 444 | 不变 |
| server→capability deep | 0 | 0 | 不变 |
| seam violations | — | 0 | 无新增跨包非 public import |

## Revision / 外部路径

- base：`origin/main` e6ca25b03（branch `refactor/yuk-1571-shared-read-models`，独立 worktree `/Users/yuqi/.t3/worktrees/the-learning-project/t3-33f77fae`）
- head：以 `git rev-parse HEAD` / checkpoint 目录名为准（本文件随 head 提交，不能自含 SHA）
- 日志与 SHA256：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/<head-sha>/`

## Commands（本机已跑）

- `pnpm typecheck` PASS（两 tsconfig）
- `pnpm lint` PASS（178 warning 全为 main 既有；本批文件 0 error）
- `pnpm build` PASS（web + server/worker/migrate 三 esbuild 产物）
- `pnpm audit:capability-boundaries` **EXPECTED-FAIL**（6 条全部是「debt decreased → tighten baseline」delta；`capability-boundary-baseline.json` 归 Grok1830 独占，本 PR 不写）
- `pnpm audit:architecture-deepening` 同上 6 条 baseline delta；5 条 stale catalog entry 已按本 head 真实边集修正 `scripts/capability-public-read-cycles.ts`（台账非 baseline）
- `pnpm audit:capability-boundaries:snapshot` 实测快照已封存

## NOT_RUN

本机不跑任何测试套件 / DB / 运行时 / provider / 付费链路；无 tsx-eval/合成输入脚本。行为验收由 exact-head CI Gate（既有 notes/knowledge/agency/ingestion/practice 单测零改动）与独立审查承担。draft #1802（review.ts proposal/runtime 迁移）未合，本 PR 仅改其 `readAgentNotes` import 一行；后合方按 main 解冲突。
