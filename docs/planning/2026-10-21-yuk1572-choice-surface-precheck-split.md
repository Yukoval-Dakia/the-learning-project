# YUK-1572 — choice-surface 确定性预检出 verify-framework（lane 交付记录）

lane：verify-framework choice-surface。base `ce74a7733f93044f55c0b00d056ae3c8d137f1fc`
（= 当时 origin/main，与协调确认 fixed main 一致；fetch 后无新增）。head 代码提交
`b49fb463f7130d84595cdec300f152fee20b80da`，branch
`arch/yuk-1572-verify-framework-choice-surface`，worktree
`/Users/yuqi/.t3/worktrees/the-learning-project/t3-85a08208`（绑定本 lane 的新树；
未写父树/别树）。唯一写权 `src/capabilities/practice/server/quiz/verify-framework.ts`
+ 新建同目录 `choice-surface.ts`；未触其他 lane 文件、schema、audit、CI、
package/lock、baseline。

## 拆分内容与边界

- 新模块 `choice-surface.ts`（392 行，纯模块）：`verify-framework.ts` base
  485–843 连续段逐字节搬入——answer-candidate kernel
  （`referenceAnswerCandidates`/`normalizeAnswer`/`choiceLabelIndex`/
  `choiceLabelPrefix`/`stripLeadingChoiceLabel`/`stripTrailingPunct`/
  `addChoiceExpansion`/`answerCandidates`）+ YUK-1624 预检块
  （`ChoiceSurface*` 四类型 + `referenceFirstLine`/`normalizeOptionIdentity`/
  `evaluateChoiceSurface`/`choiceSurfacePrecheckRecord`）。唯一外部 import
  `normalizeToCanonicalKind`（`@/subjects/question-kind`，纯函数）。
- `verify-framework.ts` 1766 → 1422 行：删该 359 行段，原位留 8 行 MOVED 指针；
  顶部加 forced re-export（见下）与 kernel 回引 import；line 51 的
  `normalizeToCanonicalKind` import 随职责迁出（本文件已无使用点）。
- 两处非逐字节适配（moved-block-diff.txt 实测仅这两处）：
  `referenceAnswerCandidates`/`answerCandidates` 加 `export`；
  前者参数 `Pick<SolveCheckQuestion, …>` 改写为结构等价的本模块
  `ReferenceAnswerSource`（字段逐一相同），避免 verify-framework ↔
  choice-surface 反向类型边。语义、异常、顺序、对象身份零变化。

## 受保护区无变证明（cmp 逐段）

`protected-regions.txt`：base[1,50]、[52,60]、[61,67]、[68,484]、
[844,1766] 五段与 head [1,50]/[51,59]/[67,73]/[75,491]/[500,1422] 全部
IDENTICAL。即 line 43 json-extract import、content validation(~220)、
solve-check 类型与 flags、独立 solver authority/provider、
`runIndependentSolution`/`runSolveCheck`(852–1515)、teaching-quality(1633+)
逐字节不变；测试与 fixture 零改动（verify-framework.test.ts 只 import
`runIndependentSolution`，不受影响）。

## 闭包与消费者证明

- 闭包（closure.txt）：搬出的 16 个声明内部 callee 全在集合内；不引用
  verify-framework 遗留声明。`isExactQuestion`/`extractJsonObject` 不入集
  （只被 runSolveCheck / solve+teaching 用，已证非闭包成员，未动）。
- 消费者（consumer-map.txt，repo 全扫）：`evaluateChoiceSurface`/
  `choiceSurfacePrecheckRecord`/`ChoiceSurfaceRuleCheck`/
  `ChoiceSurfacePrecheckRecord` 唯一外部消费者 = `jobs/quiz_verify.ts`
  （admission lane 文件，本 lane 不可改）→ re-export 为强制 compat 缝。
  `normalizeAnswer`/`ChoiceSurfaceRule`/`ChoiceSurfaceQuestion` 外部零消费者，
  不再从 verify-framework 导出（死公开面 −3，交父登记非自签）。
  kernel 三函数由同文件 `runSolveCheck` exact 路径真实回引。
- forced re-export（不自签 stable/compat，分类交父裁决）：
  `export { choiceSurfacePrecheckRecord, evaluateChoiceSurface }` +
  `export type { ChoiceSurfacePrecheckRecord, ChoiceSurfaceRuleCheck }`，
  站点 verify-framework.ts:65-66，消费者 quiz_verify.ts:111-117/474-475/750/759。
  提案分类：cross-lane 强制 compat，待父整合 quiz_verify lane 时可收。

## 两个真实变化场景

1. 选项呈现/标签一致性规则演化（如放行小写标签、新分隔符、`E` 超界标签的
   新处理）：Before 在 1766 行 verify-framework 内改，与 solver/provider/
   paid 编排同文件共审；After 只改 `choice-surface.ts` kernel 段。caller
   （quiz_verify 预检 + runSolveCheck exact 路径）不再需知标签包装形态、
   候选展开与规范化细节——它们只见 `evaluateChoiceSurface` 的 checks 与
   `answerCandidates` 的展开结果。
2. provider 验证编排变化（新 veto 轴、异源 solver lane、settle/release
   记账调整）：Before/After 都改 verify-framework；`choice-surface.ts` 不随
   纯编排变化——职责边界即「确定性规则 vs 付费编排」，与本 lane 授权一致
   （后者本批无变化点）。

## 五标准对账（诚实项）

- 责任：新模块 owns「答案串↔选项面」全部确定性规则（标签解析、候选展开、
  规范化、重复判定、引用命中），不再与付费 verify 框架混居。
- 接口：9 个导出 / 392 行实现；`ReferenceAnswerSource` 与 5 个 kernel helper
  为内部缝不外露。verify-framework 对该模块只依赖 3 个函数 + 转发 4 符号。
- 隐藏知识：标签形态词表、候选展开顺序、规范化规则全部收进模块；caller
  只传 question 投影收 checks/candidates。
- 修改局部性：场景 1 修改点单文件化（原需在同文件跨 507-826 区段理解
  solver 上下文）；场景 2 不变。不夸大——两文件同目录同 capability，
  跨文件调试成本仍在。
- 行为证据：逐字节搬移 + 两处声明式适配；无运行时重放（无依赖环境，
  见 NOT_RUN）。等值论证为 cmp/diff 证据非实测执行。

## 行数与边界成立性

verify-framework 1766→1422、choice-surface 392——两文件均 <1500；原文件在
超长清单中，本拆分如实使其退出（按文件物理行数，非宣称收益）。边界=纯度：
新模块零 I/O/零 provider/零 DB；留下的是 paid 编排与框架声明。

## 预测 audit delta（未自改 baseline，交父实测登记）

- practice→subjects 边：verify-framework 失 `question-kind` 边、新模块得
  同边——capability→subjects 计数预期不变；新增 verify-framework→
  choice-surface 为同包内边（预期不入跨域台账，实测为准）。
- 公开导出：verify-framework 死面 −3（上列）；新模块 +9 导出。
  >1500 文件数预期 −1（1766→1422）。SCC/cross 预期不变。
  以上均为候选 head 预测，`pnpm audit:*` 待 frozen install 后实跑对账。

## 验证状态

- 本机实跑：git/cmp/diff/grep 字节证明、`node --check`（v26.10.0，
  type-strip parse）两文件 PASS——syntax-check.txt。
- NOT_RUN：node_modules 缺失（setup 未备依赖，未自行 install）→ typecheck/
  lint/build/audit:* 均未跑；tests/vitest/DB/Docker/provider/runtime/demo
  按 owner 规则禁跑。请父安排一次 frozen install 后经 heavy.sh 补跑。

## 证据

`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/b49fb463f7130d84595cdec300f152fee20b80da/choice-surface/`：
moved-block-diff.txt、protected-regions.txt、consumer-map.txt、
closure.txt、syntax-check.txt、env.txt、diff-full.patch、commit-stat.txt、
checks-sha256.json（全部 sha256 登记）。
