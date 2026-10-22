# 录入声明贯通 compose 与统一发布

Refs YUK-1568、YUK-1522。交付阶段：第一天能用。只交现役 ingestion agent 的源码候选，
不代表四类生产端全部完成。独立 QuizGen 按 ADR-0069 §5 的已定退役方向保留旧对照链；
统一候选生成的收口仍属 YUK-1594 的后续。已接受的 #1949/#1956 不在本片复核范围。

## 范围与基线

- 唯一 writer 工作树：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-383f783b`。
- 分支：`feat/yuk-1568-ingestion-declarations-20261022`。
- fresh fetch 基线：`af4b30bf97a2906f221573f83c19d15d76253e46`；隔离树原始
  `ee4b92bea329dde7d88609469e217dd2bb473c1d` 落后 223 个提交，未在旧基线上实施。
- 产品只改 ingestion task、compose 工具、已有 block presentation 保存职责。
  `draft-contract.ts`、shared-submit、codec、准入/paid/run/budget/history/UI 均只读。
- `block-structured-edit.ts` 的 merge/reassign 等函数正文不变；唯一相关 import 调整
  直达早已拥有完整 writer 的 kernel lifecycle 模块。
- 保留 #1958 的注释意图：去历史票号/审查轮标签与过时自查叙述，保留 raw UPDATE 对
  fold 不可见、rebuild 会抹掉 presentation 的理由；不取其整份 PR。

## 有依据的声明进入真实生产文档

`ingestionAgentTaskSpec.prompt.build` 读取当前草稿与 answer-shape 版本常量，说明
`schema_version=2` 的 `parts[].units[]`、select/blank/free 与 set-compare/exact/free
方法、unit 私有 key/rule、材料引用以及稳定身份。interval_set、finite_set、number/unit、
point、affine_line 与 blank_order 的字段来自当前 question-draft、blank-answer-shape、
blank-answer-compare、scoring-rule 源码。finite_set 当前只实现 roster，point 当前至多
8 轴；合法 schema 不代表 notation 已有 executor 支持。

只凭题文/材料声明对象、单位、顺序与对应；不从学科/format=math 推断，不能猜分隔符、
裸数政策、容差、分值/部分分或 item 对应。不把印刷参考答案/学生手写当 key；独立求解
不出则缺 key，缺印刷政策则省略/unknown rule，缺分值为 null/省略，沿用 ask/withheld。
没有声明的旧文档不默添数学类型或更改 exact/normalization 语义。

生产入口仍是 `edit_question(action=save, document)`，不是新的 writer。材料资产仍来自
既有 source/media 工具；系统 `agentInterceptInput` 继续盖 `photo_ingest` 与
`ingestion_agent:<sessionId>`，各自 taskRunId/logTaskRunId 的用途保持。

## 场景一：只改 presentation、保存与重放后继续 edit/submit

以下是源码推演，不是运行样本。设 edit 的真实回执为 `qdraft1:B:v`、版本 v，compose
固定请求 K 携带该 ref 与 presentation P。

1. compose 解析版本化 ref；显式 expected_draft_version 若与 ref 不同则 rejected_input。
   v2 保存必须有版本和 request_id。`setPresentation` 先对 K 取与 edit/submit 同形的
   advisory request 锁，再查既有 `experimental:question_draft_save` 回执；没有回执才
   `FOR UPDATE` 读 B，核存在、draft 状态和版本 v。没有先锁行再抢 request 锁的反序。
2. 锁内 callback 对当前 `structured` 解析 v2，检查声明支持，调用唯一转换函数：
   `draftDocumentToContract(doc, doc.base?.question_id ?? block.imported_question_id ??
   \`draft-${block.id}\`)`。用该契约的 structure/response_spec/scoring_basis 调
   `validateStructure`、`validateResponseSpec` 和与 publish 同源的 `validatePresentation`；
   duplicate_id 也明确阻断。缺 key/rule/points 不是获准入依据，仍由 submit 保留未决。
3. 保存 owner 从锁定原文构造 `{...block.structured, presentation:P}`，不接受模型整份
   AFTER 文档覆盖其它字段。原 parts/units、局部 items、part/unit/slot/item 身份、
   answer_shape、blank_order、key/rule、materials、source/base/metadata 不被改写。
   `persistStructured` 仍检查 genesis anchor，同事务写 job event、
   `experimental:edit_question_block_structured(op=set_presentation)` 完整快照，再经
   `projectQuestionBlockGuarded` 投影；没有 raw structured UPDATE。
4. 首次保存版本从 v 到 v+1，B 不变，回执为 saved、新 `qdraft1:B:v+1` 与
   draft_version/block_version=v+1。原 ref 仍指 v，不被改造成“当前别名”。该事务
   还写既有 draft-save 回执 action，payload 仍是 request_id/fingerprint/receipt；
   不加 event schema 字段、表或 registry。fingerprint 绑定 tool、actor、B、期望版本、P。
5. K 与相同操作输入重放时，在行锁前返回原回执（附 replayed=true），无版本递增、
   无第二次 job/canonical/receipt 事件，返回的 ref 仍是 `qdraft1:B:v+1`。
   同 K 异操作输入返回 request_id_reused；无原回执且过期版本返回 draft_version_cas
   与 current_draft_ref/current_draft_version，不覆盖、不自动重试。
6. task 的真实工具流程用 compose 回执替换手上旧 ref/version，并在 item 进度保存它，
   随后调用 `submit_question({request_id, draft:{draft_ref, expected_draft_version}})`。
   若继续 edit，也用新 ref/version；edit 保存后再次用 edit 的新回执。resume 时 actor
   仍是 session 级 ingestion_agent 身份。若重放后另一次编辑已推进版本，旧回执照原样
   返回，后续 edit/submit 的既有 CAS 会冲突；重放不虚称自己返回的是当前版本。
7. submit 的 request_id 仍由既有 interceptor 按 session + 实际 draft_ref 生成；不复用
   compose 的 K。`submitDraftQuestion` → `submitDraftQuestionInTx` 再锁定/解析该版本，
   用同一 `draftDocumentToContract`，经既有去重、conversion/admission/contract barriers
   和 `publishQuestionGroup` 唯一 revision writer，才产生 canonical revision/ref。
   compose 首次或重放都不铸 revision；submit 自己的成功回执重放保持原 revision 身份。
   验证意图仍按原事务/commit 后派发；本片不新增 verify 或 paid 调用。

材料和组身份的同源性有精确边界：两个入口传的都是同一 v2 文档。codec 的
`contractMaterial` 保持 material_id/kind/asset/visibility/caption/alt_text/content_md，
按原文映射 part/material/slot/unit 及局部 item 引用；展示 bind 只引用这些身份，不引用
group_id。新题 compose 的 `draft-B` 是暂用组名；submit 会选择真实 groupId
（base/imported id，或现有 producer id/createId）。这不保证两次 integrity digest 相等，
而是保证换组名不重铸展示绑定身份，submit 会在真实组契约上重新校验 P 并生成正式 seal。
已有组按 base/imported 身份保持一致。

草稿 source_ref/metadata 是草稿留痕，既有 codec 按其明确契约不把这些字段塞入 revision
材料；本片不改变该边界。系统 source 保留在草稿，经原 submit 写 question.source_ref/
metadata.submit_source；private key/rule 与允许冻结的材料进入正式四层契约。

## 场景二：旧文档、损坏/不支持声明与冻结 revision

- 任何携 schema_version 的文档先进入版本分派。非当前版本返回 unsupported_contract；
  v2 解析失败返回 rejected_input/invalid_draft_document；当前比较器不支持的声明返回
  unsupported_contract/unsupported_answer_shape；v2 转换抛错返回
  unresolvable_contract/invalid_draft_contract。各分支直接返回，不吞错落入 legacy。
- v2 的缺 key/rule/points 等转换未决项仍由 submit 原门 withheld，不借展示 valid 改成
  admitted。草稿及其声明留存，不删 answer_shape/blank_order 强行降为旧比较。
- 不带版本且符合既有 legacy 守卫的 StructuredQuestion，继续旧 deriveDraftContract →
  normalizeQuestionRowToContract 单行路径，沿用图资产摘要读取与绑定校验；legacy
  block_id 保存不强加 v2 身份要求。没有声明时不补数学语义。
- revision_id 只读取冻结的 structure/response_spec/scoring_basis 校验；save=true
  仍直接 skipped:revision_readonly，完全没有 revision 写入路径。

## 依赖与验证边界

静态机器 snapshot：capability→server 总数 384→384，ingestion→questions 10→11、
ingestion→projections 9→8；server→capability deep 0→0，cross-capability value 36→36。
baseline 记录真实 draft codec 与真实 kernel lifecycle/canonical-json 消费，不改 audit、
阈值或自签豁免。这只说明架构门的净变化，不能替代上面的保存/身份/绑定语义证明。

本树依赖已独立在 heavy.sh 下 frozen 安装（exit 0）；不借原树依赖覆盖。本机仅允许
typecheck/lint/build 与现有静态 audit。所有重活通过 heavy.sh，单 lane 串行，全机 2 slots，
Node heap 上限 3072 MiB。实际结果：

- `pnpm install --frozen-lockfile`：0。
- 改动的 3 个产品文件及 baseline 的 `biome check --write`：0；只作格式整理。
- `pnpm typecheck`：最终 0（先修正 issue union/narrowed return，再收紧输入联合后复核）。
- `pnpm lint`：0，181 warnings；不把 exit 0 写成零警告。
- `pnpm build`：0，含 web/Start/server/worker/migrate bundle，未启动这些服务。
- `audit:capability-boundaries --base af4b30bf97a2906f221573f83c19d15d76253e46`：0，
  新依赖 3 条均登记、0 新 blocked server entry、SCC 数与大文件数均不增加。
- 同基线 `audit:architecture-deepening`：0；没有新 pass-through site。
- `audit:tool-params`：0，ingestion 19 个工具参数面无 violation；只装载 schema，不执行工具。
- `audit:question-writers`：0，内容 writer 均已登记。
- `audit:fold-writes`：0，**report-only**；输出 8 violations、29 advisory、1 stale registry。
  这些列出的路径本片未修改，不作本轮裁决，不称该输出为零缺陷通过。
- `git diff --check`：0。

初次 typecheck exit 2 发现本片 issue union 与 narrowed return 类型错误，已在本片修正。

NOT_RUN：任何测试/断言或 fixture、DB/TEST/Docker、模型/provider/付费/真实 compose、
浏览器/部署/daemon；没有生成可冒充真实输出的样本。独立 R1/必要 R2、exact-head CI、
后续真实模型/DB/browser acceptance 由父统一安排。本片不 watch/poll/merge。
Linear capture 归父统一；本片没有另发现可执行的范围外跟进，已知验收欠账不另建重复票。
