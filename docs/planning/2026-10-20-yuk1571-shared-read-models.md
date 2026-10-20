# YUK-1571 LIGHT — 共享读模型下沉 `kernel/read-models`（交付记录）

协调线已批准的 LIGHT 共享读归属调整：L1/L2/L3 三组读责任合成本单 PR；原本即单实现多消费，不把本片称为新增算法信息隐藏。只读搬迁，无运行时 registry/DI/新机制。FULL merge 所有权方案另待 owner 裁定，与本片无实施依赖。

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

1. **过期/目标代理规则调整**：前后都只改一个读实现；本片不减少该场景的改动点。变化是读事实归 kernel，knowledge 评审无需再依赖 agency 的写能力公共面，agency 写侧与 board 装配仍归自身。
2. **知识节点页或 scout 扩展只读投影**：原本经 notes/public，读接口变动需理解 notes 的公共面；现在从职责明确的 kernel 读模块取值，笔记写入/同步仍留 notes。没有消除此前不存在的重复实现；调用方仍须理解自己选择的投影。

## 行为保持证据

- `kernel/read-models/{notes-read,artifact-corrections,extraction-summary}.ts` 与原文件逐字节一致（`git show e6ca25b03:<orig> | diff - <new>` → IDENTICAL）。
- `agent-note-hints.ts`、`artifact-backlinks.ts` 的全部搬迁区间（类型、注释、函数体、SQL）与原文件逐字节一致（python difflib 按行区间对比 → IDENTICAL）。
- 排序/limit/期限/可见性/父链/null/异常与 SQL 语义零改动；全部纯读，无锁。

## 残留 compat 与退出

- `agency/server/notes.ts`、`notes/server/{notes-read,block-refs,artifact-corrections}.ts`、`ingestion/server/tools/record-tool-support.ts` 保留显式 re-export shim，供包内消费方与各自 `public.ts` 兼容面继续工作（零改动）。`ingestion/server/tools/query-records.ts` 仍经 compat 导入（未在本批点名范围）。
- 退出路径：compat shim 在全部包内消费方迁到 kernel 后可整体删除；不在本 PR。

## 指标（实测，base=origin/main baseline）

| 指标 | base | head | 说明 |
|---|---|---|---|
| cross-capability value edges | 47 | 42 | −5：K→A 2→1、K→N 1→0、A→N 3→2（evidence-mcp，设计算术漏算的第五条）、A→I 1→0、P→I 2→1 |
| nontrivial SCC | 1×5 cap | 1×5 cap | 不变（N 经 N→K→A→N 仍在环） |
| capability→server | 440 | 440 | 不变（main 已含 frontier #1837；此前独立测量441→441，非本片额外减边） |
| server→capability deep | 0 | 0 | 不变 |
| seam violations | — | 0 | 无新增跨包非 public import |

merge `origin/main`（21 commits，含 YUK-1630 provider、YUK-1567 paid/subject、#1843 audit 合并）对本片 18 文件**零冲突零改动**；merge 后重测仅含本片 5 条减少，无未知增减。协调线解除 #1830 对 baseline 独占后，本片已按实测收紧 `capability-boundary-baseline.json`（total 48→43 + 5 pair），并新增 `YUK1571-shared-reads` note 记录读归属迁移、退出的 5 条读依赖、残留 compat 与未解 SCC；baseline 既有 notes 全部保留。

整合已合 #1837（main `de061af07`）后，再测 cross47→42、server440→440；本片五条削减与原实现保持，frontier基线note原样保留。只有baseline数值冲突，按合成源码实测解决；原48→43/441记录属于独立测量历史。R1与唯一R2已完成，本次组合由父核源码保持并重跑检查及新exactCI，不开启第三审。

## Revision / 外部路径

- base：`origin/main` e6ca25b03（branch `refactor/yuk-1571-shared-read-models`，独立 worktree `/Users/yuqi/.t3/worktrees/the-learning-project/t3-33f77fae`）
- head：以 `git rev-parse HEAD` / checkpoint 目录名为准（本文件随 head 提交，不能自含 SHA）
- 源码 revision `3078acd4f61c38a5695d110b161efc7d5e13311c` 的日志：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/3078acd4f61c38a5695d110b161efc7d5e13311c/`；`checks-sha256.json` SHA-256 `f29a316df1fe0a76a133be36fecd2abbc79119e75d4ca4faf8ab8887b57d47b8`。
- merge+baseline 后最新 head 的日志：同根 `YUK-1571/<head>/main-baseline-release/`（不覆旧目录）。

## Commands（本机已跑）

merge 前（revision `3078acd4f`，base e6ca25b03）：

- `pnpm typecheck` PASS（两 tsconfig）
- `pnpm lint` PASS（178 warnings，未将警告总数当作与 main 逐项等价的证明）
- `pnpm build` PASS（web + server/worker/migrate 三 esbuild 产物）
- `pnpm audit:capability-boundaries` **EXPECTED-FAIL**（6 条全部是「debt decreased → tighten baseline」delta；当时 baseline 归 Grok1830 独占，本 PR 不写）
- `pnpm audit:architecture-deepening` 同上 6 条 baseline delta；5 条 stale catalog entry 已按本 head 真实边集修正 `scripts/capability-public-read-cycles.ts`（台账非 baseline）
- `pnpm audit:capability-boundaries:snapshot` 实测快照已封存

merge `origin/main@1440e864b` + 首次 baseline 登记后（历史独立head b14730e31）：

- `pnpm typecheck` PASS；`pnpm lint` PASS（179 warnings，+1 为 merge 带入的既有级 warning）；`pnpm build` PASS
- `pnpm audit:capability-boundaries` **PASS**（debt ratchets exact：capability->server=441 / server->capability-deep=0 / cross-capability-value=43）
- `pnpm audit:architecture-deepening` **PASS**（SCC 台账核对通过；totals 441/0/43 低于上限 531/70/62）
- `pnpm audit:capability-boundaries:snapshot` 实测快照已按新 head 封存

## NOT_RUN

本机不跑任何测试套件 / DB / 运行时 / provider / 付费链路；无 tsx-eval/合成输入脚本。行为验收由 exact-head CI Gate（既有 notes/knowledge/agency/ingestion/practice 单测零改动）与独立审查承担。draft #1802（review.ts proposal/runtime 迁移）未合，本 PR 仅改其 `readAgentNotes` import 一行；后合方按 main 解冲突。

#1837合入后组合head的命令结果另存 `YUK-1571/<head>/post-frontier-integration/`，以父检查结果和新exact-head CI为准，不用旧b147的绿色代替。
