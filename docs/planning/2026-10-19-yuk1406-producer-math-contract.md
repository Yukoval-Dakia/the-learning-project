# YUK-1406 首片：producer 数学定界契约 + legacy choice→select 双序号修复

- 日期：2026-10-19
- 分支：`fix/yuk-1406-producer-math-format`（base = origin/main `6067a05de8cf9d26499c4a8f7bed35659693dd00`）
- 阶段：第一天能用（W0）。PR **Refs** YUK-1406、YUK-1568，不 Closes——本片只修
  producer 契约与转换边界，存量与七题网页验收不在本片内。

## 原因（为什么改）

60 题真题 PDF 验收（YUK-1529 附带发现，归 1406）暴露两类确定性缺陷，父线已亲读
DTO 与 paid payload 逐字段确认：

1. **裸数学命令**：`cooygx01cb5iz5uqmln990lo`（quiz_gen）选项 C/D 含裸
   `\frac`/`\sqrt`，`ubm6yaiw98qdnpddjrjbnc78`（web_sourced）选项 B 含裸
   `\dfrac`——两题 `prompt_md` 内的 `$…$` 均正常，缺陷恰好集中在未定界的选项
   正文。paid payload（batch-3-paid-after.jsonl 第 23/170 行）证明**准入前**
   `options[i].text` 就已裸露（label 独立 A/B/C/D），即裸公式不是准入删定界
   造成的；但原 producer wire（模型原始输出）仍不可证明，本片不伪造该证据。
   取证记录：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1406-options-20261019/provenance.md`
   （已纳入迁移 ops-evidence-v1，SHA
   `22c3b140d45d3babb95734929aa55fa8d86f7c8c85f02880275a22d537b196d9`）。
   Revision 关联口径：cooygx 原 application 直接 r1vww；ubm 原 application
   仍 eya6、当前 b3 仅经 repair verification 关联（不是原 application 直接
   发布 b3）；resolved/published digests 不同、分别保留。web_sourced 的
   extract 文本 B 仅剩 `y=`（公式缺失），原 producer wire 未找到，不冒充
   原网页。旧 paid/receipt 保持原样。
2. **双序号**：同一 payload 的 `resolved.response_spec.slots[0].items[i]` 里
   `label_md = "C. …"`，而渲染端 `OptionListBlock.tsx:155-164`（mark span）与
   `worksheet-plan.ts:215-221`（`letterFor(order)`）都**各自画序号**——双序号
   确由 `definition-from-contract.ts` 的 `label_md: \`${option.label}. ${option.text}\``
   转换引入。

2026-10-10 owner 决策：**producer 明确 math delimiter，renderer 不猜裸公式结束**；
code/prose/已有 math 各安其位。本片是该决策的首片源头修复。

## 最终行为

### 1. QuizGen producer 数学定界（prompt + outputSchema 双层，仅显示字段）

> **R1 修复轮（Codex gpt-6.1-sol xhigh，REQUEST_CHANGES 1 P1）已收窄**：初版把
> 强制扩展到了 `reference_md` 与 structured `answers`/`analysis`，而这些字段经
> `extractAnswerHead` / `structuredToReferenceMarkdown` 进入 exact
> `text_key`（`assessment-normalization.ts` 铸 accepted_texts；
> `judge-routing.ts:148-161` 去答案标记/尾解析/强调符但**不去数学定界**；
> `grade.ts` 按字符串命中）——强制包装会把显示定界带进评分键，造成
> `solve_seed_mismatch` 拒收合法题或裸公式正确作答被判错。父裁决最小修法：
> **撤回对答案值承载字段的一切本片新增强制**，不扩全局评分，不改
> extractAnswerHead / grade / 全局归一化。参考展示与独立答案值的分离归后续
> **K1 quiz_gen typed 生产迁移**，本片不冒充覆盖。

- **Prompt**（`src/capabilities/practice/tasks/quiz-generation.ts`）：「数学定界
  （强约束，仅题面与选项的显示字段）」——行内 `$...$` / 独立 `$$...$$`，已有
  `\(...\)`/`\[...\]` 可保留；`\frac`/`\dfrac`/`\tfrac`/`\sqrt` 等命令禁止
  裸露在定界外；字面展示放行内代码或代码块；覆盖 `prompt_md`、`choices_md`、
  `structured` 各节点 `prompt_text`/`options[].text`。**reference_md 与小题
  answers/analysis 是判分消费的答案值（与 answer_anchor 裸正文同格式），不受
  本条约束**。题面不另抄选项；组合题 sub 的显示字段同样遵守。
- **outputSchema**（`src/core/schema/quiz_gen.ts`）：`QuizGenQuestion` 新增
  superRefine——仅对上述显示字段调用共享检查，命中即以字段路径 + 可执行错误
  拒收，例：`choices_md[2]含裸\frac，请给数学式加$...$，若为字面代码请放code…`。
  **落地形态（R1 核实，如实）**：QuizGen 是 posthoc 解析——provider 返回后
  handler `parseOutput`（`jobs/quiz_gen.ts`）才 `QuizGenOutput.safeParse`；
  TaskSpec 无 `structuredOutputMode`/`structuredOutputSchema`，**没有同 run
  数学反馈/参数修复接线**；失败经 `placementSchemaFailure` 只保留 code/path
  （本片写的 message/excerpt 不透传）；pg-boss 既有 `retryLimit=2` 有界重试
  会重走 plan/generate 并**可能再次消费付费额度**。本片不新增重试/反馈/预算，
  也不声称「免费拒收 / 同 run 修复已接通」。
- **保护（不误伤）**：math span / 行内 code / 多 backtick 与 tilde fence /
  escaped delimiter（`\$`）/ legacy `\(...\)`/`\[...\]` 均不报；语法取自渲染器
  自己的管线（unified + remark-parse + remark-math，先例
  `src/kernel/proposals/presentation.ts`），legacy 定界用镜像自
  `src/ui/lib/math-markdown.tsx` `LATEX_DELIMITED` 的正则（keep in lockstep）。
  **刻意不查**：`source_refs`（URL/snippet 溯源）、`material.body_md`（抓取
  原文——不改 source 原文）、`rubric_json`（judge-only 判据）等非渲染字段；
  **以及答案值承载字段 `reference_md` / structured `answers` / `analysis`
  （R1 P1 撤回，见上）**。
  **不做**：不为裸串自动补 `$`、不求解、不全局重写数学、不猜公式跨度。

### 2. legacy single/multi_choice → select 的 label_md 仅原 option.text

`src/capabilities/practice/server/admission/definition-from-contract.ts`：转换
产物 `label_md` 从 `${option.label}. ${option.text}` 改为仅 `option.text`（空
正文省略，同 `draft-contract.ts:600-612` 先例）。与
`core/schema/question-draft.ts:493`（`label_md: opt.text`）对齐——本仓原生
select 的 label_md 一直是纯正文，此转换点是唯一加前缀的例外。

**保持不变（已核消费方）**：`item_id = option.option_id`、`slot_id`/`part_id`/
`placement`、选项顺序、`pick`、答案键映射（`select_key.accepted_item_ids`/
`option_set_key` 均按 id）、盲解语义（`solve.ts:217-220` solver 按 `item_id`
应答，`display_md` 仅读题显示；variant 反序本身已排除字母坐标）；原生
`select` 槽位原样透传，不 strip 既有 `label_md`；**历史 receipt 恢复读冻结的
input/resolved 持久化数据，不重跑转换**——旧指纹/策略/已付行不受影响，本改动
只作用于新转换。参考答案字母展示（`resolved-publication.ts:441-446`）由
item 顺序派生，与 label_md 内容无关。

## 已核对的 label_md 消费方清单

| 消费方 | 行为 | 影响 |
| --- | --- | --- |
| `practice/ui/blocks/OptionListBlock.tsx:155-164` | 自画 mark + 渲染 label_md | 双序号消除 |
| `practice/ui/worksheet/worksheet-plan.ts:215-221` | `letterFor(order)` 自画 + label_md 为正文 | 双序号消除 |
| `admission/solve.ts:217-220` | `display_md` 仅显示，判分认 `item_id` | 无 |
| `admission/resolved-publication.ts:441-446,462-467` | 字母按位置派生；choices_md 取 label_md | 正文更干净 |
| `ingestion/server/assessment-capture.ts:95-117` | 圈选字母→item 按 label_md **前导 token** 解析 | R1 裁决：未证明本片新增可达回归（见下） |

## 未覆盖入口 / 已知边界（如实列出，不宣称 1406 全票 Done）

1. **assessment-capture 的 label 解析**（ingestion 线，非本片写权，未改动）：
   `resolveSelectLabels` 按 label_md 前导 token 解字母的依赖本身脆弱（首 token
   碰撞时无展示坐标校验，不能笼统保证不误判）。**R1 独立裁决：现役 capture
   走 `q_capture_*` 先 legacy 发行（同事务 row normalizer 发布，不经本片
   converter；选择题初始为 legacy single/multi，捕获走 option.label 映射）；
   capture 重入读 issuance 冻结 revision（非 current），未找到把本片新转换
   select 送进该函数的真实产品路径——即本片未证明新增可达回归。**旧的脆弱
   前缀依赖不是本片修复，本片也不改 assessment-capture / slot-renderers。若
   将来修圈选，须按该张作答卷实际冻结的展示映射（issuance revision /
   option_order / presentation marker）反查 item_id，不得把字母塞回
   label_md（R1 建议归属 ingestion capture resolver）。
2. **答案值字段的定界（R1 撤回项）**：reference_md / structured answers /
   analysis 的显示包装与评分语义分离归后续 **K1 quiz_gen typed 生产迁移**；
   在那之前本片对答案字段无任何新增强制，exact 评分语义、extractAnswerHead、
   grade、全局归一化均未动。
3. **web_sourced / sourcing 裸公式**（ubm 同缺陷族）：共享检查已就位
   （见下），但 sourcing 侧接线由其独占 writer 后续完成，本片不碰。
4. **存量题目**：YUK-1573 冻结期间不修存量、不动旧题/paid；两道 DTO 样本
   （含旧 ttnpco/eya6l 缺定界）保持原样。
5. **重复题干**：另有样本待查（父线），本片不处理，不用 regex 从 prompt 删
   选项。
6. **producer wire 根因**：原模型原始输出仍不可证明存在（初版 provenance 误报
   已更正），本片修的是确定性边界（schema 契约 + 转换），不是对历史 wire 的
   追责。
7. `embedMaterialInPrompt` 在 parse 后嵌入的 material 原文不带定界时不触发检查
   （source 原文不改）——producer 契约只约束 agent 自产字段。

## 共享 API（后续 sourcing 接入点）

`src/core/question-math-markdown.ts`（新）：

- `findBareMathCommands(markdown: string): BareMathCommandIssue[]` — 每命中返回
  `{ command, excerpt }`；空数组 = 符合契约。纯函数、无 IO。
- `BARE_MATH_COMMAND_NAMES: ReadonlySet<string>` — `frac/dfrac/tfrac/cfrac/
  sqrt/binom`（数学模式专属、散文零误报判据；扩充保持同判据）。
- `BareMathCommandIssue` 接口。

sourcing 线最小接入点：在其输出 schema 的渲染字段 superRefine 里对每个字段调
`findBareMathCommands`，用字段路径拼同款可执行错误（参照 quiz_gen.ts 的
`reportBareMath`/`reportStructuredBareMath` 形状）。**不要复制第二份
validator，不要造 registry**。注意同样只接显示字段，不接答案值字段（R1
P1 同理）。本共享 API 在 R2 关闭前视为未接受状态。

## NOT_RUN（本片未运行的验证，如实声明）

- **DB / 容器 / TEST / provider / HTTP / runtime**：全部未运行（任务边界禁
  止）。schema 检查的实际拒收行为、mimo-v2.5-pro 对新 prompt 的遵循率、
  admission 新转换的真实 resolved 形状，均未经真实运行验证。
- **七题网页 / 两题 DTO 回放**：未运行（需 UI 线与真实 issuance，非本片范
  围）。
- **测试**：未编写、未运行（owner 2026-10-10/10-11 规则；本片不变量属
  producer 格式契约，如需断言测试须先出文本方案报协调线批准）。本地仅
  typecheck / lint / build 与既有 audit。

## 检查证据

见交付报告：`pnpm typecheck` / `pnpm lint` / `pnpm build` 与既有 audit 的实际
exit code（含 `audit:schema`、`audit:question-writers`、
`audit:capability-boundaries`、`audit:test-policy`）。R1 修复轮完整日志落
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1406-options-20261019/pr1827-r1-fix-logs/`。

## 修复轮记录

- **R1（fixed fefd9d56b）**：Codex gpt-6.1-sol xhigh，REQUEST_CHANGES，1 P1
  （显示定界进 exact 键）+ 两项重点疑点裁决（capture 可达性未证明；落地为
  posthoc 拒收、既有重试可能再付费）。报告：
  `pr1827-r1-codex-fefd9d56b.md`（同目录）。
- **R1 修复**：撤回答案值字段新增强制（schema 三处 + prompt 覆盖面两处）、
  纠正本文档与 PR 的落地 claim；原 5 文件 scope 不变，未新增文件。
