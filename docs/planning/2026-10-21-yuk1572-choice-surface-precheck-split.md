# YUK-1572 — choice-surface 确定性预检出 verify-framework（lane 交付记录）

lane：verify-framework choice-surface。base `ce74a7733f93044f55c0b00d056ae3c8d137f1fc`
（= 当时 origin/main，与协调确认 fixed main 一致）。branch
`arch/yuk-1572-verify-framework-choice-surface`，worktree
`/Users/yuqi/.t3/worktrees/the-learning-project/t3-85a08208`。
head（交付 doc 提交前）：`92e4c4ead17495658114302525e5437b742b8667`，其中代码
`b63b5449` + `92e4c4ea`（注释修正），初版 `b49fb463f`。唯一写权
`verify-framework.ts` + 新建 `choice-surface.ts`；经主线占用核验后获授权改
`jobs/quiz_verify.ts` 顶部 import（仅 4 符号拆行）；其余文件、schema、audit、
CI、package/lock、baseline 未触。

## 拆分内容与边界

- 新模块 `choice-surface.ts`（392 行，纯模块）：`verify-framework.ts` base
  485–843 连续段逐字节搬入——answer-candidate kernel
  （`referenceAnswerCandidates`/`normalizeAnswer`/`choiceLabelIndex`/
  `choiceLabelPrefix`/`stripLeadingChoiceLabel`/`stripTrailingPunct`/
  `addChoiceExpansion`/`answerCandidates`）+ YUK-1624 预检块
  （`ChoiceSurface*` 四类型 + `referenceFirstLine`/`normalizeOptionIdentity`/
  `evaluateChoiceSurface`/`choiceSurfacePrecheckRecord`）。唯一外部 import
  `normalizeToCanonicalKind`（`@/subjects/question-kind`，纯函数）。
- `verify-framework.ts` 1766 → 1414 行：删该 359 行段，原位留 MOVED 指针；
  `runSolveCheck` exact 路径经 1 行 import 回引 kernel 三函数；
  line 51 `normalizeToCanonicalKind` import 随职责迁出。本文件对
  choice-surface 无任何 re-export/compat 面。
- `quiz_verify.ts` 1788 → 1790 行（+2）：4 符号改从
  `../server/quiz/choice-surface` 独立 import（biome 排序位），其余 8 符号
  import 行逐字节保留；job 正文（base 124–EOF）逐字节不变。
- 两处非逐字节适配（moved-block-diff.txt 实测仅这两处）：
  `referenceAnswerCandidates`/`answerCandidates` 加 `export`；前者参数
  `Pick<SolveCheckQuestion, …>` 改写为结构等价的本模块
  `ReferenceAnswerSource`，避免反向类型边。语义、异常、顺序、对象身份
  零变化。

## 受保护区无变证明（cmp 逐段，protected-regions.txt）

- verify-framework：base[1,50]/[52,60]/[61,67]/[68,484]/[844,1766] 与 head
  对应段全部 IDENTICAL——line 43 json-extract import、content validation、
  solver authority/provider、`runIndependentSolution`/`runSolveCheck`、
  teaching-quality 逐字节不变。
- quiz_verify：base[1,108]/[109]/[124,EOF] 与 head 对应段全部 IDENTICAL；
  保留的 8 个 import 行与 base 逐字节一致。paid/publish/fence/placement/
  recovery 正文零变化。
- 测试与 fixture 零改动（verify-framework.test.ts 只 import
  `runIndependentSolution`）。

## 闭包与消费者证明

- 闭包（closure.txt）：搬出的 16 个声明内部 callee 全在集合内；
  `isExactQuestion`/`extractJsonObject` 证非闭包成员未动。
- 消费者（consumer-map.txt，逐绑定核对）：`choice-surface` 共两个
  from 子句消费者——verify-framework（kernel 3 名）与 quiz_verify（4 名），
  全部与导出对得上。verify-framework 六个 importer 的每个绑定仍被导出。
  `normalizeAnswer`/`ChoiceSurfaceRule`/`ChoiceSurfaceQuestion` 外部零
  消费者，不再从 verify-framework 导出（死公开面 −3，交父登记）。
  无 re-export：拆分后不存在 pass-through 缝。本轮未遇新调用方。

## 两个真实变化场景（诚实版）

1. 选项呈现/标签一致性规则演化（放行小写标签、新分隔符、超界标签新处
   理）：Before 与 After 都是单文件编辑（1766 行 verify-framework →
   392 行 choice-surface）。本拆分不改编辑点数量；真实变化是完整纯规则
   与 paid 编排分离——改规则时不再与 solver/provider/记账代码同文件共审，
   规则审读面收敛到纯模块。caller 侧知识不变：它过去就只调用
   `evaluateChoiceSurface`/`answerCandidates`，从不掌握标签解析细节。
2. provider 验证编排变化（新 veto 轴、异源 lane、settle/release 记账）：
   Before/After 都改 verify-framework，`choice-surface.ts` 不随编排变化。
   本轮该场景无实际修改点。

## 五标准对账（诚实项）

- 责任：新模块 owns「答案串↔选项面」全部确定性规则；付费 verify 编排
  留在 verify-framework。
- 接口：9 个导出 / 392 行实现；5 个 kernel helper 与 `ReferenceAnswerSource`
  为内部缝。
- 隐藏知识：标签词表、候选展开、规范化规则收进模块内部；caller 的知识
  面不变（它本就只见函数签名与返回）。
- 修改局部性：规则类修改的审读范围从混合 1766 行文件收敛为 392 行纯
  模块；编辑点数不变（前后各 1 文件）。不称新增算法深度——深度来源
  是既有规则原样归位，非新机制。
- 行为证据：逐字节搬移 + 两处声明式适配；父 AST 28 函数体逐字一致
  （`parent-function-body-proof.json`）；运行时重放不在 lane 授权内。

## 行数与边界成立性

verify-framework 1766→1414、choice-surface 392、quiz_verify 1788→1790。
原文件在超长清单中，拆分后如实退出（物理行数实测）。边界=纯度：新模块
零 I/O/零 provider/零 DB。

## 实测 audit 对账（重活均经 heavy.sh 单 lane 串行，raw 落证据目录）

- `pnpm typecheck` rc=0；`pnpm lint` rc=0（repo 180 warnings，我文件零
  命中）；`pnpm build` rc=0。
- `pnpm audit:architecture-deepening` rc=0：403/0/37（与 base 同形）、
  SCC {agency,knowledge,practice} 不变、pass-through 1088 +0。
- `pnpm audit:capability-boundaries` rc=1：唯一 violation =
  `quiz_verify.ts` 1788→1790，>1000 行增长需 `sourceSizeRecords` 登记。
  +2 为授权拆 import 的结构性最小增量（新 import 语句不可为零行，
  单行超 100 列须多行）。**未自改 baseline/门——数值如上，登记交父。**
- 边口径以实际 audit 为准：verify-framework→choice-surface 为同包内边；
  practice→subjects 边随职责迁移至新模块（`question-kind`），
  capability→subjects 计数不变；choice-surface 无新增跨域边。

## 验证状态

- 实跑：上述 5 门经 heavy.sh（argv/UTC/真实 rc 全录）；cmp/diff/grep
  字节证明；`node --check` 三文件 PARSE OK（v26.10.0）。
- NOT_RUN（owner 规则）：tests/vitest、DB、TEST、Docker、daemon、
  provider、runtime、demo。

## 证据

`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/92e4c4ead17495658114302525e5437b742b8667/choice-surface/`：
5 门 `*.log`+`*.exit`（argv/UTC/真实 rc）、moved-block-diff.txt、
protected-regions.txt、consumer-map.txt、closure.txt、syntax-check.txt、
env.txt、diff-full.patch、commit-stat.txt、checks-sha256.json。
父侧证据在 `…/YUK-1572/c2cfb668f9b60eaa694507791c8eecd1a29be93a/`：
`parent-function-body-proof.json`（28 函数体逐字一致）、
`parent-frozen-install.json`（frozen install rc0）。
