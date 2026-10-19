# YUK-1568 第 1 片：K1 答案声明（answer_shape / blank_order）贯通与中央再发布保护

2026-10-19。关联 YUK-1496（K1）、YUK-1559（C1）、YUK-1404（存量结构）。设计依据
[唯一设计 R1 闭环版](../../../Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/yuk1568-k1-answer-semantics-plan.md)
（仓库外绝对路径；本片不重审设计）。本片是四片顺序中的第 1 片：**只做声明与往返 + 保护**，
不含数学比较器（第 2 片）、不含生产端调用方迁移（第 3 片）、不碰 40 题存量（第 4 片，
独立方案）。

## 本片交付了什么

### 1. 单一声明定义（`src/core/schema/assessment/blank-answer-shape.ts` 新文件）

- `answer_shape = { version: "k1-math-v1", value, notation }` 的唯一 Zod 定义；草稿
  （`DraftBlankSpec`）与冻结契约（`BlankSlot`）复用同一 schema，不再出现两套同名字段。
- `value` 是封闭判别联合：`number`（可选单位输入要求 `{unit, accepts_bare_number}`）、
  `interval_set`（`binding` 声明被讨论的变量/量表达式）、`point`（`axes` 有序坐标轴）、
  `affine_line`（`variables` 有序变量）、`finite_set`（`item ∈ number|point|affine_line`、
  `order:"unordered"`、`duplicates:"forbidden"`；item=point 必须带 `axes`）。
- `notation` 只能在该 value kind 允许的输入语法里选（`NOTATIONS_BY_VALUE_KIND`），
  不是 agent 可提交的正则或代码。
- 全部 strict 对象 + `version` 字面量：**未知版本/未知字段 parse 直接失败**，不能被
  Zod strip 后当无声明继续。answer_shape 不携带正确端点/答案个数/容差 —— 判分真相
  仍在私有 scoring key。
- 解析前宽松探测：`findAnswerShapeDeclarations` / `findBlankOrderDeclarations` /
  `describeAnswerShape` —— 只认字段存在性，供 kernel 保护在 schema 判断之前识别
  "已声明但本读者不认识"的 revision。

### 2. 字段往返（draft ↔ contract ↔ draft）

| 内容 | 编辑文档 | 冻结契约 | 回草稿 |
|---|---|---|---|
| 一空回答的数学对象 | `DraftBlankSpec.answer_shape`（可选） | `BlankSlot.answer_shape`（原样保留，参与 integrity digest） | `draftSpecFromSlot` 原样带回 |
| 多空默认逻辑序 | `DraftPart.blank_order`（可选，slot_id 列表） | `QuestionPart.blank_order` | `revisionToDraftDocument` 原样带回 |

- 两字段都**可选、不注入默认值**：旧草稿/旧 revision 的 JSON 与 digest 逐字节不变。
- 局部编辑（`draft-ops.ts`）：`set/clear part.blank_order`、`set/clear
  unit.answer_shape`（只允许 blank 单元；shape 未知字段在 op 层即拒绝）。批末
  `integrityIssues` 校验 blank_order 恰覆盖本 part 的 blank 槽各一次（不跨 part、
  不指向非 blank 槽、不重复、不缺项）；发布 barrier 的 `validateResponseSpec`
  （structure+response 交叉校验）拒绝同样的问题，缺项/重复**不回退数组序**。
- `blank_order` 只是**默认逻辑序**：`slotsInDefaultOrder`（response.ts，纯函数）只在
  声明 part 的 blank 槽各自占位内重排，其余槽相对顺序不动；未声明 = 完全 no-op。
  `defaultPresentation` 与公开 DTO（`projectPracticeIssuance`，`PublicQuestionFace`
  新增可选 `blank_order`）统一读取。作答身份永远按 slot_id；显式 K5 物理布局仍以
  block/region → slot_id 绑定为准，placement 从属不变，不按序数交答案。
- 编辑失效域：`answer_shape` 进 `SOLVE_AFFECTING`（响应语义变化 ⇒ solve/calibration
  失效）；`blank_order` 只进 display + presentation 重验，不触发判分失效。

### 3. 保护（本片核心）

比较器未到位前，新声明只能存草稿或以 withheld/暂扣发布，**不能发题、不能 admitted**：

- **submit/typed seam**（`draft-contract.ts`）：声明 blank 单元 `judgeable_today=false`，
  `withheld_reason='declared_answer_shape_comparator_pending'`；提交照常可发布
  withheld revision（声明进冻结层），不回退普通 exact 自动判分。
- **publishQuestionGroup**（`assessment-publication.ts`）：声明 answer_shape 的契约
  带 `admission.state='admitted'` 时**抛错拒发**（事务回滚）。直接 typed 调用方、
  verify promote、校准回写都绕不过这道闸 —— 核验不等于新数学准入。
- **serving**（`serving-admission.ts`）：发出范围内任何声明 blank 槽 ⇒ 
  `unavailable / unsupported_deterministic_input`，detail 点名 slot 与 shape
  版本/kind，明确"不回退普通 exact 文本比较"。此闸在渲染面检查之前。
- **中央再发布保护**（`loadQuestionGroupContractSnapshot` /
  `publishQuestionGroupFromRow`）：当前 revision 携带 answer_shape/blank_order 时，
  读取以**冻结四层为权威**（digest 用库存值，source_verify C1 守卫与 admission
  `sealedRevisionContract` 看到的是同一份）；FromRow 对这类组**显式冲突抛错**，
  同事务回滚，错误信息给出 revision 与下一步（edit_question + submit_question）。
  未知/坏声明在 snapshot 读取处 fail-loud（"拒绝回退旧解释器"），不会 strip。
- **旧行为不变**：无声明 revision 的 FromRow/快照/发布路径逐字不变；旧行内容里
  不存在声明字段，flat→row 归一（assessment-normalization.ts，本片零改动）不可能
  产出声明，因此保护不改变任何现存数据的行为。

### 28 处共享行级发布口调用点的处置

清单（19 个调用方文件、28 个实调用）见
[28处调用点处置](../../../Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-backlog112-20261019/yuk1568-publication-callers.md)。
本片经 `server/questions/publisher.ts`（纯 re-export）核实：**全部 28 个实调用都
汇入 kernel 的 `publishQuestionGroupFromRow` 单一函数**，上述中央冲突对它们统一生效，
本片不改任何调用方代码。M（迁统一 edit/submit）与 P（纯状态经 typed publisher 保
契约）分类的实施属第 3 片；迁移前已声明题经这些写口的内容/状态发布一律冲突回滚。
下表是处置计划，不是已完成的迁移：

| 调用方（src/ 下） | 实调用行 | 处置（第 3 片实施） |
|---|---|---|
| server/questions/sourced-draft-insert.ts | 204,231 | M；重复候选 merge 元数据分支可 P |
| capabilities/practice/server/tools/submit-question.ts | 454 | M |
| capabilities/practice/jobs/quiz_gen.ts | 1540 | M |
| capabilities/practice/jobs/source_verify.ts | 663,981,1051 | P 候选；否则 C |
| capabilities/practice/jobs/quiz_verify.ts | 958,1022 | P 候选；内容变化则 C/M |
| capabilities/practice/server/quiz/verify-and-promote.ts | 309 | P 候选 |
| server/questions/write.ts | 459,616,801 | C→内容编辑分支 M，纯状态分支核验 P |
| capabilities/practice/server/proposal-appliers.ts | 285,515,976 | C→question_edit M，其余逐分支核验 |
| server/questions/parts.ts | 164 | C→结构改动走 M |
| capabilities/practice/server/serving-actions.ts | 324,551 | C；逐动作核是否纯生命周期 P |
| server/ai/solution-generate.ts | 196 | C（reference 回填影响评分输入） |
| capabilities/practice/server/intervention-diagnostics.ts | 688 | C |
| capabilities/agency/server/conjecture/probe-lifecycle.ts | 225 | C（新建无声明原路径不变） |
| capabilities/ingestion/server/assessment-capture.ts | 390 | C |
| capabilities/ingestion/server/auto-enroll.ts | 700 | C |
| capabilities/ingestion/server/import-completion.ts | 451 | C |
| capabilities/ingestion/server/image-candidate-accept.ts | 1006 | C |
| capabilities/ingestion/server/legacy-record-appliers.ts | 394 | C（仅旧无声明记录） |
| capabilities/ingestion/api/mistakes.ts | 122 | C 保护；实施核 identity |

补充核实：admission job（`question_admission_run.ts`）的判分级读取走
`sealedRevisionContract`（库存层 digest 封存），声明 revision 不会被 flat 重建替换；
其未支持声明的 promote 终点被 publishQuestionGroup 的 admitted 闸拦截。

## 明确不在本片 / NOT_RUN

- **数学比较器（第 2 片）**：`blank-answer-compare`、grade/solve/calibrate/
  crosscheck/编辑探针指纹接入。本片声明题在学习者侧不可出（serving 拒绝）、
  不可 admitted（发布闸拒绝）。
- **生产端迁移（第 3 片）**：sourcing / quiz_gen / 28 调用方逐分支 M/P 实施。
- **存量 40 题（第 4 片）**：不声明、不改、不重跑；不声称七题已修或 K1 完成交付。
- **DB/CI/运行验收 NOT_RUN**：本片未建任何 DB、未跑任何 DB 依赖测试（owner 未批准
  测试代码；本机不跑 full `pnpm test`）。事务回滚语义是源码路径推演（FromRow 的
  抛错发生在 `db.transaction` 内 ⇒ 整体回滚），不是运行证据。真实副本验收
  （edit→submit→serve 拒绝矩阵）待获准窗口后按设计 §6 执行。
- 未改 UI（既有 Opus 线）、未做 DB 迁移（新字段只存在于既有 jsonb 列内）。

## 验证（本机实际执行）

- `pnpm typecheck`（tsc --noEmit ×2）exit 0。
- `pnpm lint`（Biome）与 `pnpm build` 结果见 PR 描述（以实际 exit code 为准）。
- audit：`pnpm audit:schema` / `audit:architecture` / `audit:capability`（若触发的
  allowlist 契约有变，按 audits-reference 处理；本片预期只新增导出）。
- 字段往返用既有公开纯入口做临时 CLI 实跑（draft→contract→draft、未知版本拒绝、
  blank_order 重排），不写测试文件；结果记入 PR。
