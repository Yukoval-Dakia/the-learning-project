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

### 1. QuizGen producer 数学定界（prompt + outputSchema 双层）

- **Prompt**（`src/capabilities/practice/tasks/quiz-generation.ts`）：新增「数学
  定界（强约束）」条目——每个数学表达式必须自带 `$...$`（行内）/`$$...$$`
  （独立）定界，已有 `\(...\)`/`\[...\]` 写法合法可保留；`\frac`/`\dfrac`/
  `\tfrac`/`\sqrt` 等命令禁止裸露在定界外；字面展示放行内代码或代码块；规则
  覆盖 `prompt_md`、`choices_md`、`reference_md` 与 `structured` 各节点
  `prompt_text`/`options[].text`/`answers`/`analysis`。同时明确：题面
  `prompt_md` 不再抄一遍选项内容（选项由渲染层自行排版画序号）；组合题模式
  里 sub 各字段同样遵守。
- **outputSchema**（`src/core/schema/quiz_gen.ts`）：`QuizGenQuestion` 新增
  superRefine——对上述渲染字段调用共享检查，命中即以字段路径 + 可执行错误
  拒收，例：`choices_md[2]含裸\frac，请给数学式加$...$，若为字面代码请放code…`。
  **真实传播链（已核，非声称）**：handler `parseOutput`
  （`src/capabilities/practice/jobs/quiz_gen.ts:331-334`）`QuizGenOutput.safeParse`
  失败 → `QuizGenOutputFailure(placementSchemaFailure(...))` 抛出 → handler
  catch 写失败事件并 re-throw → pg-boss 自然重试；placement 路径经
  `placementSchemaFailure` 既有终态归类。**不新增** paid run、重试或 fallback；
  placement-starter 与 admission 的同 run 既有参数修复（jsonrepair 级，仅语法）
  不变——schema 级违规按既有 fail-closed 落地。
- **保护（不误伤）**：math span / 行内 code / 多 backtick 与 tilde fence /
  escaped delimiter（`\$`）/ legacy `\(...\)`/`\[...\]` 均不报；语法取自渲染器
  自己的管线（unified + remark-parse + remark-math，先例
  `src/kernel/proposals/presentation.ts`），legacy 定界用镜像自
  `src/ui/lib/math-markdown.tsx` `LATEX_DELIMITED` 的正则（keep in lockstep）。
  **刻意不查**：`source_refs`（URL/snippet 溯源）、`material.body_md`（抓取
  原文——不改 source 原文）、`rubric_json`（judge-only 判据）等非渲染字段。
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
| `ingestion/server/assessment-capture.ts:95-117` | 圈选字母→item 按 label_md **前导 token** 解析 | 见下「未覆盖」 |

## 未覆盖入口 / 已知边界（如实列出，不宣称 1406 全票 Done）

1. **assessment-capture 的 label 解析**（ingestion 线，非本片写权）：纸面圈选
   字母经 `resolveSelectLabels` 匹配 `label_md` 前导 token；label_md 无前缀后
   新转换槽位的字母圈选将解析失败 → 落**显式 `unknown`/pending（绝不误判
   分）**，与 `draft-contract.ts` 已发布的纯正文 select 槽位现状一致。后续若
   要恢复字母圈选，应由 ingestion 独占 writer 按位置（`letterFor(order)` 反查）
   解析——已报父核。`item_ids` 直传路径不受影响。
2. **web_sourced / sourcing 裸公式**（ubm 同缺陷族）：共享检查已就位
   （见下），但 sourcing 侧接线由其独占 writer 后续完成，本片不碰。
3. **存量题目**：YUK-1573 冻结期间不修存量、不动旧题/paid；两道 DTO 样本
   （含旧 ttnpco/eya6l 缺定界）保持原样。
4. **重复题干**：另有样本待查（父线），本片不处理，不用 regex 从 prompt 删
   选项。
5. **producer wire 根因**：原模型原始输出仍不可证明存在（初版 provenance 误报
   已更正），本片修的是确定性边界（schema 契约 + 转换），不是对历史 wire 的
   追责。
6. `embedMaterialInPrompt` 在 parse 后嵌入的 material 原文不带定界时不触发检查
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
validator，不要造 registry**。

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
`audit:capability-boundaries`、`audit:test-policy`）。
