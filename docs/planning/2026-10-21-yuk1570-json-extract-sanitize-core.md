# YUK-1570 — json-extract / json-sanitize 纯算法族迁入 src/core（中间交付）

- branch: `arch/yuk-1570-json-algorithms-core`
- base: `ce74a7733f93044f55c0b00d056ae3c8d137f1fc`（origin/main fixed SHA）
- worktree: `/Users/yuqi/.t3/worktrees/the-learning-project/t3-774a63b2`（仅写本树）
- 状态：PARTIAL —— 双真身已迁 + 8 个已核 consumer 改指完成；`verify-framework.ts:43`
  为 C 独占 live consumer，其 import hunk 与两个旧文件删除打包为待父原子退出 patch
  （见仓外证据路径），父在 C 最终释放后串行整合。
- 仓外证据：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/<head>/json-extract-sanitize-core/`

## 范围（逐文件）

新建（真身迁入，非 wrapper/shim）：

- `src/core/json-sanitize.ts`（83 行）= `src/server/orchestrator/json-sanitize.ts` 逐字节复制。
- `src/core/json-extract.ts`（291 行）= `src/server/ai/json-extract.ts` 复制 + 恰好 3 行差异：
  - L24 import specifier `@/server/orchestrator/json-sanitize` → `./json-sanitize`（族内边，core 零 server 依赖）；
  - L18、L167 注释中两处失效路径字样最小改写（`src/core/json-sanitize.ts` / `同簇 json-sanitize 状态机`），无语义改动。

修改（仅 import 字面量 hunk，正文零改动）：

- `recommend.ts`（agency）L11 移指 `@/core/json-extract`，按 Biome organize-imports 序位移至 L1；
- `quiz_gen.ts` L68 → `@/core/*` 组首位（L29 前）；
- `quiz_gen_plan.ts` L16 → L15 前；
- `intervention-author.ts` L40 → L6 前（`@/capabilities` 组与 `@/core/schema/intervention` 之间）；
- `multimodal-direct-judge.ts` L8 → L5 前；
- `web-sourcing-operation.ts` L28 → L23 前（文件首条 import）；
- `solve-session.ts` L15 `@/core/json-sanitize` → L4 前；
- `teaching-turn.ts` L13 `@/core/json-sanitize` → L12 前。

保持字节不变（protected，逐 blob 无变证明见仓外 `git diff --stat` 与 sha256 清单）：

- `src/server/ai/json-extract.ts`、`src/server/orchestrator/json-sanitize.ts`（旧真身，暂保留供
  verify-framework；非终态，终态为单 core 族，由待父 patch 原子删除）；
- `src/capabilities/practice/server/quiz/verify-framework.ts`（C 独占，本树零改动）。

## 闭包与消费者证明

全仓 import 字面量普查（`.ts/.tsx/.mts`，排除 node_modules/dist）：旧两模块共 9 个真实
consumer + json-extract 内部一条 → 已迁 8 + C 独占 1（verify-framework.ts:43）。无 barrel /
re-export、无测试文件、无 audit 脚本钉住旧路径。残留旧路径引用仅：
verify-framework.ts:43（待父 patch）与旧真身内部自指。`web-candidates.ts:152` 仅为注释提及，
`src/capabilities/practice/CONTEXT.md:12` 的 P4 豁免注记随之过时（建议父随退出 patch 顺手
清账，另 `src/server/AGENTS.md:24` `orchestrator/` 行在目录删除后失实——`orchestrator/` 仅含
json-sanitize 一个文件）。

## 语义保真

迁移为 byte-move：strict parse 首路径、确定性转义（内容引号/非法反斜杠/裸控制字符）、
容器闭合触发与风险拒绝、riskyRepair/containerClosure/latexEscapes 选项语义、jsonrepair
依赖与梯度顺序、原 SyntaxError 对象与消息、`[json-extract]` console.warn 前缀与条件、
无 `{...}` 时 null——全部逐字节保留（diff 仅上述 3 行）。不触及 AgentRunError /
provider-session-admission / 错误 class / hash 规范化 / paid consumer 正文。

## 两个真实变化场景

1. 修复算法规则变化（如调整梯度顺序或新增确定性转义）：迁移前改 `src/server/ai/` 与
   `src/server/orchestrator/` 两个 server 子树；迁移后整条规则族同处 `src/core/json-*.ts`
   单目录。caller 少知道的事：引擎的两个 server 落点；接口不变。
2. 新领域 consumer 用纯算法：迁移前任何 capability 调用即新增 capability→server 债边
   （ratchet 审计类）；迁移后 capability→`@/core/*` 边不在 ratchet 三类审计边内，新消费者
   不依赖 server 运行时即可使用。如实说明：本片是完整职责归位 + 同接口迁址，接口未深化、
   caller 步骤未减少；收益是边界层位正确与规则族同址。

## 五标准对账

- 责任：LLM 输出宽松 JSON 提取/净化一族一责，未变；
- 接口：`parseJsonObjectLoose` + `LooseJsonResult`/`ParseJsonLooseOpts`/`RepairLevel` /
  `sanitizeJsonStringLiterals` 签名与语义零变化；
- 隐藏知识：梯度顺序、转义启发式、闭合策略仍在族内，不外泄；
- 修改局部性：规则族由两个 server 子树收拢到单一 core 目录（真实改善，非行数拆分）；
- 行为证据：见下「机器实跑 / NOT_RUN」。

## 行数与边界

原 291+83 行 → 新 291+83 行；两文件均远低于 1500 行阈值，拆分边界成立的依据是
两族各有独立 live consumer 集（sanitize 单用：teaching-turn / solve-session；extract
全量梯度：quiz supply 族），合并会强迫 sanitize-only consumer 牵连 jsonrepair 依赖，
故保持两文件小接口，如实说明未到 1500。

## 机器实跑 / NOT_RUN

- 实跑（本机，非 heavy）：`git diff` 逐 hunk、全仓 import 普查、新文件与 8 consumer 的
  `biome check`（全局 2.5.7，仓 pin ^2.5.8，指示性）：10 文件 0 error、0 organize-imports
  诊断；仅 2 条既有 warning（quiz_gen `noUnusedImports`@L104、intervention-author
  `useOptionalChain`@L922，行位与 hunk 无关，base 同存）。
- NOT_RUN：`node_modules` 缺失（本树未装依赖、未 install）；typecheck / lint（仓 pin 版）/
  build / 全部 audit:* / 测试 / DB / provider / Docker 均未跑。源码与静态证据已齐，
  报父安排一次 frozen install 后补跑。
- 待父原子退出 patch：`pending-verify-framework-import-and-deletes.patch`（verify-framework
  import 改指 + 排序位移 + 两旧文件删除，针对 ce74a77 版生成；若 C 释放后 import 块变动，
  按「`@/core/json-extract` 置于 `@/core/*` 组、`@/capabilities` 组之后」规则重导）。
- baseline 预计实测差量（父登记，不预付）：capabilityToServer `agency -> ai` 25→24、
  `practice -> ai` 61→56（verify-framework 那条待 C 后 55）、`practice -> orchestrator` 1→0、
  `copilot -> orchestrator` 1→0，total 403→395；kernel/core→server 新边 0；server 源文件
  数待退出 patch 后 -2（orchestrator/ 目录消失）。
