# YUK-1407 — process answer correction（第一天能用）

Branch: `fix/yuk-1407-process-answer-correction`（base `origin/main` bace0bdc7）。
本文件 = file-level 实施计划 + 部署后人工复核 runbook。Refs YUK-1407（验收未完成，不 Close）。

## 已确认的 bug 机制（source-trace，非旧报告复述）

活判分路径只有一条：submit → `commitFormalAttempt` → `evaluateSubmission` →
`evaluateSubmissionCore` → `runDeterministicComparator`。judgeAnswer/JudgeInvoker
legacy 面只剩 calibration 采样消费。

报告的失败（`S₅=11` 完整过程判 0）走 `exact_text` comparator
（`src/core/schema/assessment/evaluation.ts`）：`normalizeText(mode='answer_head')`
对学习者整段推导调 `extractAnswerHead`，学习者文本里没有 `解析：` 之类的
tail marker ⇒ head = 整段推导 ⇒ 与 accepted `11` 不等 ⇒ `scored 0` →
激活 → settlement 把错误 FSRS/θ 效应落下去，confidence=1 +
"no accepted answer key matched"（`projectEvaluationToJudgeResult`）。

`exact_text` unit 的 plan executor 是 `deterministic`；该 criterion 在既有
model executor（Jev/pi/rubric）上都被拒绝（"deterministic criteria belong to
declared comparators"），且当前无 text_key 的已准入模型切片（D17）。因此
"exact miss → SemanticJudge" 在 native 契约路径**没有可走的语义执行器**；
本 ticket 不新建判分器，不绕过准入。

## 改动切片

### A. 确定性终态答案提取（核心修复）

`src/core/schema/judge-routing.ts` 的确定性提取合同（parent actual-output
复核发现 R1 初修仍会误发满分，本次窄修替换该策略，不代表 PR 验收）：

- `extractFinalAnswer(text)` 接受完整答案声明行，或最终句中从
  句首/逗号/分号开始的 `所以/因此/故/综上/即/∴` 结论从句；
  无标记时只认**完整末句** `identifier = value`；新增有肯定结果词引导的
  完整句末赋值从句，详见文末真实终态修复记录。identifier 限 ASCII/希腊
  字母开头、后续同类字母/数字/下划线；NFKC 使 `S₅＝11` 对应 `S5=11`。
- 标记后的文本/复合值整体保留。删除 copula 后缀提取与任意 prose 中等式
  子匹配；不把 `答案不为11`、`结果不可能是11`、`前五项和为11` 化为 `11`。
  这些是可作 exact 比较的**完整字符串**，不是对其肯定/否定语义的判断；
  与 key `11` 不匹配时由调用方保守处置，不扩大否定词 denylist。
- 只有整个候选满足单一 `identifier = value` 时，才补充**完整 RHS** 作为
  等价表述。`S5=11` → `[S5=11,11]`，`S5=11!` → `[S5=11!,11!]`；
  不截取最后数字/最后等号。比较关系、复合 LHS、等式链均 `ambiguous`。
- 不剥数学标点、负号、括号、乘号或 Markdown 边缘字符。候选若经既有公开
  `extractAnswerHead` 会改变 token（如尾随 `*`、句号），整个提取拒绝为
  `ambiguous`，避免 native `answer_head` 的二次归一化吞掉数学含义。
  `!` 保留为阶乘；`11!` 只可匹配 `11!`，不能匹配 `11`。
- 多个不相容的最终答案声明、同变量结论或不可降为中间量的结论 →
  `ambiguous`；此前不同变量的合法完整结论赋值不作为最终变量的答案。
  无明确语法 → `none`。
  `isProcessLikeAnswer` 现在也认完整结论标记（含单行 `所以…`）；其 miss
  进入既有 `needs_review`，短裸答案 `11`/`12` 行为不变。

### B. `exact_text` / `blank_exact` miss 语义（evaluation.ts）

`exact_text` 头比较 miss 后：
1. `extractFinalAnswer` found → 候选集与 `accepted_texts` 在同一归一化下
   确定性比较：命中 → scored full（evidence 记录提取值+marker）；
   未命中 → 过程文本 ⇒ pending `needs_review(flagged)`（不伪造 0；
   单位/等价形式超出本比较器合同）；单句短答 ⇒ 维持 scored 0。
2. ambiguous / none + 过程文本 ⇒ pending `needs_review(flagged)`。
3. none + 短答 ⇒ 维持 scored 0（短答/choice/exact 行为不变）。

`blank_exact`（entry.state='answered' 且 key.kind='text' 且过程文本）同形
拦截，复用 `normalizeBlankText` + `evaluateScoringRule`；不碰 `grade.ts`
（#1796 在途文件，readonly——空白槽的过程作答覆盖如需共进，向 parent 报备
后再并入；本实现仅在 `evaluation.ts` 的分发点拦截，不改其内部）。

未决 ⇒ 聚合 `unresolved(pending_units)` ⇒ `coarse_outcome='unsupported'` ⇒
`commitFormalAttempt` 回 `review_required`、不激活、不写学习效应 —— 诚实
"未判"，绝不落伪零分。

### C. 判词依据回执（route/basis/confidence）

`judgment.ts` 的 `ScoredUnitResult`/`PendingUnitResult` 增加可选 `judged_by`
（执行器/比较器 id），`comparison` 增加可选 `final_answer`（提取值与 marker）。
分发点在 `evaluation.ts` 统一盖印；`projectEvaluationToJudgeResult` 已把
`unit_results` 放进 `evidence_json` —— route/basis 随既有回执通道流出
（submit 响应 `judge.evidence_json`、judge_run DONE、双轨裁决读模型）。
confidence 语义不变（确定性=1，未决=0）。

### D. legacy/V2 exact 判官同形修复（语义升级已推迟）

`src/core/capability/judges/exact.ts` 与
`src/capabilities/practice/server/judge/exact.ts` 在 head-miss 后同样走
`extractFinalAnswer` 候选比较；提取不到明确终态且输入为过程文本时 V2 返回
`unsupported`（证据标注 `process_answer_unresolvable`），V1 维持 incorrect
但 evidence 显式标注（calibration 面可读差异）。

**语义升级不在本 PR**：coordinator 终态范围 —— SemanticJudge fallback 推迟到
executor + admission 就绪的独立小切片。invoker 不新增语义回退，
`process_answer_unresolvable` 如实透传 `unsupported`（诚实未判，不伪零）。

### E. 可逆纠错 proposal（agent → 人审 → 既有 appeal/replay 链）

复用 `judge_retraction` kind（UI meta 已存在；提案天然 pending/reversible）。
- producer：`writeEvaluationCorrectionProposal`（kernel/proposals/producers.ts）
  —— target `{subject_kind:'evaluation'}`，proposed_change 携带
  `evaluation_id`/`correction_kind`(`rejudge`|`assert`)/`reason_md`/
  `observed` 快照/可选 `asserted_unit_results`。
- 接受面：`judgeRetractionProposalAcceptApplier`（practice proposal-appliers）
  —— evaluation 目标：写 `experimental:appeal_request` → `rejudge` job 走既有
  异步重判链（rejudgeNativeAppeal 重评冻结输入 → activateSubmissionCandidate
  CAS → settlement replay 自动回算 FSRS/θ/掌握度）；`correction_kind:'assert'`
  时以 `manual_assert` 模式同步产出人工判 candidate 再激活。
  legacy judge-event 目标：写 `correct`/`retract` 事件（既有事件纠偏链）。
- **并发/重试纪律（R1 review）**：
  - proposal 创建时在组 advisory lock 下读 `evaluation_effective_head`，把
    `expected_effective_id`/`expected_generation` 冻结进 proposed_change；
    accept 与 activation CAS 只认该快照 —— head 已移动 ⇒ `stale_correction_target`
    拒绝（重报新提案）或 CAS `conflict` 如实返回，绝不静默 rebase 覆盖后到纠错。
    已完成 accept 的重放天然非变异（evaluation_key 重放 + CAS + 确定性事件 id）。
  - durable correction event / accept rate 都不是投递证明：rejudge 路径任何
    重试都先补一遍 singleton enqueue（`singletonKey=correctionEventId`，60s
    窗口内去重；窗口外 dup job 由精确 resolution 检查、付费前持久申诉绑定、
    既有 claim/result 回执及 activation CAS 分别约束）再判定完成。
    singleton 只压缩投递，不是 exactly-once 证明；crash 恢复身份见下方 P1-3 修复。
- `acceptSupportedProposalKinds` 纳入 `judge_retraction`，strength C→B
  （人审档位，不是自动执行）；`scripts/audit-architecture-deepening.ts` 的
  `producerOnlyKinds` 同步移除该 kind。
- agent 入口：practice 新增 `propose_grading_correction` DomainTool
  （manifest `copilotTools` 注册）—— 校验 evaluation 存在且 completed、
  pending proposal 去重，proposal 携带 observed 判词快照作 grounding。

### F. `rejudgeNativeAppeal` null-head 防御

当前 `head?.effective_evaluation_id !== expected || head.generation !== gen`
在无 head 组上会 TypeError。proposal-accept 的纠错允许非 effective 目标
（7 条未决评价没有 effective head），必须 null-safe。

## 不做的事 / 边界

- 不新建判分器/执行器/回算子系统；不经由未准入切片调模型；不改全局
  provider/budget 配置。
- 不回写历史 evaluation/score/mastery/FSRS；纠错一律 = 新 candidate +
  activation + settlement replay。
- `grade.ts` 不动（#1796 在途）；`source_verify`/`admission`/`runner` 等排除
  清单不动。
- UI 零编辑：judge_retraction 在 `KIND_META`/`ProposalCard` 已由
  `acceptSupportedProposalKinds` 动态门控，accept CTA 自动出现；inbox-api.ts
  两处旧注释过时（已移交 parent 说明），无行为问题。

## 7 条未决评价（5 needs_review + 2 unjudgeable）的诚实出口 —— runbook

部署后由 parent 执行（需要真实 DB；本 lane 不做真实数据操作）：

1. 对每条 evaluation 行，agent 或人工调 `propose_grading_correction`
   （或直接写 judge_retraction proposal，target=evaluation）→ owner 在收件箱审：
   - **rejudge**：accept → 异步重评冻结输入。对 `human_review`/`unadmitted`
     unit 仍会回到 needs_review/unjudgeable —— 这是"未自动可判"的诚实终态；
     激活的未决评价走 settlement `ineligible`（不计入），不产生伪效应。
   - **assert**（人工判读该题正误）：proposed_change 带
     `asserted_unit_results`（每个 in-scope unit 一条 scored/pending）→
     accept 后 `manual_assert` evaluation + 激活 + settlement 真实回放效应。
   - **dismiss**：维持未决 = 不计入（不假装完成）。
2. needs_review/unjudgeable 条目的**永久消除**仍依赖对应判分能力准入
   （模型切片 admission）或题目修键——本票只提供诚实出口，不伪造能力。
3. 报告形态的 S5=11 误判（effective incorrect）：appeal/correction → 重判
   提取 `11` → correct → 激活替换 head → settlement revert+replay 旧效应 →
   FSRS/θ/掌握度自动重算（既有 replay 闭包，无新机制）。

## 提取器窄修交接（2026-10-18；非新 review round）

唯一 writer 工作树：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-eb173c3f`，
起始 HEAD `fff33390a3d64c756c4bf771a24166087ecf8c20`，同分支/同 draft PR #1797。
本次只改 `judge-routing.ts` 与本文；消费者/纠错/CAS/enqueue/准入/AI/UI
均只读或未触及。原 3 项 P1 的独立最终复核仍由 parent 在真实产物上执行。

### 实际输出证据

以下来自直接调用公开 `extractFinalAnswer` 与 `evaluateSubmissionCore`，
使用既有 `evaluation.test.ts` fixture 结构的内联 frozen revision/submission，
未导入或运行测试文件、无 assert/mock、未写任何测试或 harness 文件。
key 除特别注明外为 `11`，满分 1；均 `model_units_invoked=0`。

- baseline 实际 CLI：`/private/tmp/yuk1407-extraction-repair-before.jsonl`。
  `答案不为11` / `结果不可能是11` 原来带候选 `11`；`所以11!` 原来只剩
  `11`；`不是S5=11` 原来也会取到 `11`。parent 原始失败输出保留于
  `/private/tmp/yuk1407-parent-fff333-extraction.jsonl`。
- 修复后完整实际 CLI：`/private/tmp/yuk1407-extraction-repair-after.jsonl`。
  `所以答案不是11` / `所以答案不为11` / `所以结果不可能是11` 只保留完整
  否定字符串；`所以11!` 保留 `11!`，native 均 `pending needs_review`。
- `11`、`S5=11`、`答：S5=11`、`推导\nS5=11`、`推导\n所以 S5=11`、
  `因此 S₅＝11`、完整多行等比数列过程末行 `所以 S5=11` 均 `scored 1`。
- `推导\nx<=11`、`推导\nS5=10=11`、`推导\n不是S5=11`、
  矛盾明示答案、无结论过程均 `pending needs_review`，无数字碎片满分。
- `所以11!`（key `11!`）、`答：S5=11!`（key `11!`）、
  `答：北京`（key `北京`）、`答：(1,2)`（key `(1,2)`）均 `scored 1`；
  `所以(11)`、`所以-11`（key `11`）均未匹配，保留括号与负号。
- `所以11*` / `所以 S5=11*` / `所以 S5=11。` 提取 `ambiguous`、
  native `pending needs_review`；中间一次实际输出曾暴露 native
  `answer_head` 对 `11*` 的吞字符，修复前中间日志完整保留为
  `/private/tmp/yuk1407-extraction-repair-intermediate.jsonl`，不当作最终证据。

### 明确限制与验收边界

- **等式链不求值**：`S5=1+2+8=11` 与 `S5=10=11` 都保守 `ambiguous`；
  不证明每一环等价，不新增数学语义引擎。父核验后补充：裸单行连等式也是
  过程作答，提取不支持时必须进入复核，不能因为只有一行就伪造0分。
- native 原有短答政策保留：裸单行 `x<=11`、`不是S5=11` 为提取不支持但
  非过程文本，先前直接调用观察仍
  `scored 0`，**不是**所有 ambiguous 都被 native 判为 pending。
  `答：前五项和为11` 对 key `11` 同样不猜 copula，短答仍 `scored 0`。
- 不支持一般代数 LHS、任意 prose 内嵌等式/无边界结论、带边缘 Markdown
  包装的提取。该次窄修对带尾句号等会被现有 answer-head 改写的提取也保守拒绝
  （中文句号的过程句边界已由文末真实终态修复更新，其他 token 保护保留）；
  可降低自动命中率，不能据此声称完整自然语言/数学表达式等价识别。
- 这是抽取语法与 native 纯函数 actual-output，不是 DB/worker/浏览器/真实
  学习者验收。无 provider/模型调用，无人工作业纠错执行；不恢复 legacy
  SemanticJudge fallback、不绕过 admission。语义判分仍延期至 executor +
  admission 切片；人工纠错仍按上方 runbook 人审。
- 上述限制已报告 parent，整体接受仍需独立验证审及真实页面验收；未称
  parent 已接受短作答误判。作者按授权不修改 Linear/PLAN/.remember、不发 review
  请求、不 merge、不执行 QA。

### 本次检查

本次三项均 exit 0（串行，无同时 build）：
- `pnpm typecheck`：`/private/tmp/yuk1407-extraction-repair-typecheck.log`。
- `pnpm lint:ratchet`：`/private/tmp/yuk1407-extraction-repair-lint-ratchet.log`；
  179 warnings / 0 infos，基线 210 / 0，未改基线。
- `pnpm build`：`/private/tmp/yuk1407-extraction-repair-build.log`。

42 条直接函数实际输出对应 `judge-routing.ts` SHA-256
`81c40f40d9d6d8a3a4299aaa0508e7ac8264c76a169313745153d8c69fd9cb75`。
未写/改测试代码；测试套件 NOT_RUN（owner 指定）。本次完整差异副本：
`/private/tmp/yuk1407-extraction-repair.patch`；最终提交/推送身份另封存
`/private/tmp/yuk1407-extraction-repair-delivery.log`。

### 父核验补充：单行连等式

父在作者释放写权后，只补充过程文本判定：含多个等号的单行也属于过程，
不支持的连等式走 needs_review；未增加连等式求值或语义 fallback。
直接调用 `evaluateSubmissionCore`（合成冻结输入，无 mock/断言/模型调用）
实际9条输出在 `/private/tmp/yuk1407-parent-chain-core-output.jsonl`：
“不为11”“不可能是11”、11! 和两种连等式均 pending；正确过程/答前缀/11
均得1分；短错答12得0分。每条 `model_units_invoked=0`。
父 typecheck、lint:ratchet、build、diff check 全部通过，日志前缀
`/private/tmp/yuk1407-parent-chain-`。这是内核输出观察，真实页面/DB仍未验收。


## 8d301cc 的 P1-3 实施记录（sole R2 后；不是新 review round）

以下保留当时计划与静态论证；其中 native reservation 与 binding 因果子链两点
已被 CI 39118649013 证伪，最终修正与验收边界见下方「CI 回归修复」。

起点 `8720150a65a43c0ae810fee579c8b00ed4611a30`；唯一 writer 为本次 implementation。
已完整读取 R1 `/tmp/yuk1407-pr1797-review-40fc2e64a-r1.md` 与 sole R2
`/tmp/yuk1407-pr1797-verification-8720150a6-r2.md`。P1-1 提取器、P1-2
冻结 head/CAS 已由 R2 CLOSED，保持不动；本次只修 P1-3 的付费恢复身份。

窄化文件级方案（先记录、后产品编辑）：

1. 新增 practice 内 `server/assessment/appeal-execution.ts`：复用 event/writeEvent
   保存不可变申诉执行绑定（申诉 id + execution key + 完整 member/submission/revision
   输入 digest + model intent digest + attempt + admission snapshot）。在既有组锁内提交，
   早于任何 model claim/spend；冲突不覆盖、不换身份。另在分配 attempt 时读取同组同
   submission 的已存 native binding、申诉 binding、历史 model claim，跳过预留槽位。
2. `server/judge/evaluate-submission.ts`：保留 sealed evaluation_key replay 优先；
   在 load transaction 内建立/重用 appeal binding，模型执行使用该固定 attempt，
   恢复仍交既有 claim/result 回执处理；已占槽位直接 conflict，绝不 fresh identity。
   admission snapshot 沿用首次绑定。legacy 无 binding 的申诉若创建后出现 model claim，
   且该 claim 之前没有同组/同 submission/attempt 的 binding，无法证明归属，持久
   记录 model hold；确定性单元继续正常计算。claim/appeal 的直接
   因果先后在 SQL 用 dispatch_seq 比较（不用 JS number、不作订阅完整性水位）；
   不把已 sealed result 误当可再次购买许可，也不猜另一申诉的 claim 归属。
3. `server/assessment/appeal.ts` 只读：沿用真实 appeal 调用者，不伪造
   JudgeExecution/pending run，不改已关闭的 head/CAS 或原模型预算/执行策略。
   `manual_assert` 虽有 review_context，但不调用模型，保留原合同不加模型绑定。
4. `jobs/rejudge.ts`：已解决仅认 assessment_appeal_resolution 的因果回执；
   新 binding 挂在 appeal 因果链上，但不是 resolution，不得让重投被提前跳过。
5. 本文与同 draft PR #1797 body：记录三项 P1 状态、A/B/crash 读写顺序、历史
   未知的保守处理、允许检查及真实 DB/runtime 证据缺口。parent 负责聚焦核验/QA、
   Linear 和根文档；review 预算已耗尽，不发 R3。

无 migration、新通用 subsystem、测试代码、临时断言 harness、测试套件、DB/queue/
worker/services/containers/provider/paid/TEST/QA 操作；不修改排除文件或已有回执。
静态检查仅 typecheck、lint:ratchet、build 与触及的 schema/capability/architecture/
structured-judge/provider-attempt-truth audits；这些不能证明 crash DB 行为。


### P1-3 实现结果与三项 P1 状态

- **P1-1 CLOSED（sole R2，8720150a6）**：提取器/过程判定本次零修改。
- **P1-2 CLOSED（sole R2，8720150a6）**：proposal frozen-head/stale CAS 本次零修改。
- **P1-3 已实现源码修复，待 parent 对该已知项聚焦核验及真实 QA**：本次不是
  新 review round，也不把静态通过写成 DB/crash 验收通过。initial + sole R2 预算
  已耗尽；不发 R3、不 merge、不请求 QA、不写 Linear/根 PLAN/.remember。

最终文件只有本文与三个产品文件：
`src/capabilities/practice/server/assessment/appeal-execution.ts`（新 receipt 与槽位读取）、
`src/capabilities/practice/server/judge/evaluate-submission.ts`（付费前 live consumer）、
`src/capabilities/practice/jobs/rejudge.ts`（resolution 精确语义）。
计划中的 `assessment/appeal.ts` 最终只读，预算/模型策略未变。

#### 稳定身份与落库顺序（source proof，不是运行结果）

1. `evaluate-submission.ts:547–605` 先按 group + evaluation_key 查 sealed candidate，
   验证同一 intent digest，命中即返回，不再执行模型或分配 attempt。
2. 未命中时，在既有 assessment-evaluation-group 锁及 load transaction 内，
   `reservedEvaluationAttempt` 取同 group/submission 的 native binding、申诉 binding、
   历史 model claim 的 attempt 上界，与 sealed evaluation 上界取 max。所有经该入口
   的分配者（含另一合法 appeal B、manual_assert、native pending run）避开预留槽位。
   读取 native binding 仅为避位，不赋予/接管其 run/workflow/send authority。
3. `bindAppealExecution` 验证真实 appeal action/subject/prior evaluation/group/reason，
   且 execution_key 必须为 `appeal:${appeal.id}`。不可变 receipt ID 为
   `evt_appeal_binding_${canonicalHash([group, execution_key])}`；payload 严格校验并冻结
   appeal id、group、anchor submission、完整 input_snapshot（revision id、member set、
   issuance 范围、含 revision integrity + 每个 member 冻结输入的 digest）、intent_digest、
   attempt、初次 admission snapshot 与 model hold 原因。intent_digest 沿既有合同包含
   input、mode、policy、source、assisted、review_context、asserted results。
4. **binding load transaction COMMIT → model claim COMMIT → executor → result COMMIT
   → candidate seal → 原 CAS activation/settlement**。绑定不匹配或槽位被不同 candidate
   占用即 conflict；不会用新 attempt 重买。binding 的 COMMIT ack 丢失时没有进入执行；
   重试读同 receipt。模型运行时不持 load transaction；原组 session lock 仍只负责串行。
5. A 新绑定 N 后 claim/pay，再在 candidate 前崩溃：B 即使早已创建但尚未执行，也
   会看到 N 的 reservation，分配 N+1；A 的先行 binding 可证明其 claim 归属，因此
   B 不会仅因 A 的已绑定 claim 被当成历史未知。若 B 终态未决、head 不变，A 重投
   仍按自身 binding 取 **N**，不取 latest+1。既有 recorded executor 对同
   group/submission/N/unit 查同 `evt_model_claim_*`/`evt_model_result_*`：有效 result
   重放；result 缺失/无效、digest 不同或旧 held outcome 均保持非重试未知，不重发。
   即使 B 已占 N+1、原 A result 已 sealed，也不会形成 A 的第二个付费身份。
6. candidate 已 sealed、resolution 尚未落库时重投：第 1 步直接重放 candidate，
   激活仍用原冻结 head；有效 head 已移走仍按既有 CAS conflict，不静默 rebase。
   binding 的 caused_by_event_id 指向 appeal，但 handler 只把
   `experimental:assessment_appeal_resolution` 当作已解决，binding 不能吞掉恢复 job。

#### 历史/未知的兼容处理

- 原 claim/result、evaluation、native binding 均不修改、不重置、不覆盖；新 receipt
  仅由既有 writeEvent 追加，带 ingest_at opt-out，不派生学习记忆。无 schema migration。
- 历史 appeal 已有同 key sealed candidate：保留原 replay。无 binding 的 appeal，若
  创建后有同组 model claim 且 claim 前没有该槽位的新申诉 binding，则不能证明它
  没付过费，持久绑定为 **model hold**；模型端口只返回非重试 infra_failure，无新
  claim/provider 调用。确定性单元照常计算，manual_assert 继续原合同。
- 原 R2 旧 A/N → B 把 N seal 成未决 → A 重投的存量形态，也会命中上述历史 hold，
  包括 A 旧 result 已 sealed 的情况；不猜归属、不以 result 存在推导重新购买许可。
  held candidate 可有新的候选序号，但该绑定永久禁止模型执行，不作为新付费身份。
- 只用 SQL dispatch_seq 做 appeal commit → 后续 claim 的**直接因果比较**，不用
  JavaScript number，也不用它充当订阅完整性水位。只有 claim **之前**的新申诉
  binding 才能证明归属；后补 binding 不可洗白旧 unknown。旧 native binding 单独
  不用于证明历史 claim 归属，因为旧分配者可能撞到它尚未 claim 的预留槽位。
- 保守边界：旧 appeal 创建后若出现无法归属的另一运行 claim，也可能 hold 该
  appeal 的模型部分，需要显式对账；这是历史信息缺口，不自动归到另一个 lane。
  新申诉在没有此种历史歧义时继续支持已准入 model regrading；新 A/B 的互相穿插
  由各自先行绑定区分。不能以清空 binding、claim 或新 operation id 自动恢复 unknown。

#### 本次实际检查与证据界限

以下全部 exit 0，日志前缀 `/private/tmp/yuk1407-paid-binding-`：

- `pnpm typecheck` → `typecheck.log`。
- touched-file Biome → `focused-lint.log`。
- `pnpm lint:ratchet` → `lint-ratchet.log`，179 warnings / 0 infos，基线 210 / 0 未动。
- `pnpm build` → `build.log`（SPA、Start、server、worker、migrate 只构建，不启动）。
- `pnpm audit:schema` → `audit-schema.log`。
- `pnpm audit:capability-boundaries` → `audit-capability-boundaries.log`。
- `pnpm audit:architecture-deepening` → `audit-architecture-deepening.log`。
- `pnpm audit:structured-judge` → `audit-structured-judge.log`。
- `pnpm audit:provider-attempt-truth` → `audit-provider-attempt-truth.log`。
- `git diff --check` → `diff-check.log`。

无新/改测试代码、临时断言 harness 或测试套件执行。DB、queue、worker、services、
containers、provider、paid、TEST、真实页面、真实学习者、QA 均 NOT_RUN；没有用 CLI
合成输出冒充崩溃对账。exact-head CI 本次不等待、不判 PASS；parent 后续读取实际状态。
P1-3 读写顺序为源码论证；真实 PostgreSQL kill/ack-loss/intervening B、历史 receipt
对账及重新入队仍需 parent 的受锁真实窗口。整票 YUK-1407 仍未完成。


## CI 回归修复（8d301cc 后；implementation，不是 R3）

起点 `8d301cc864f47187338cb191083686c79ceb8740`，同一隔离工作树/分支，唯一产品
writer。完整读取四处现有断言和相关失败日志：
`/private/tmp/yuk1407-ci-8d301cc-{db1,db2}.log`、
`/private/tmp/yuk1407-ci-8d301cc-summary.md`。run `39118649013` attempt 1
明确 FAILED：DB1/8 三项失败，DB2/8 一项失败；不是 flaky，不重跑 unchanged head。
父级原指向 8d 的实际 QA 已 HOLD；本次不发 QA、不发 review、不 merge、不改 tracker。

### 两项失败裁决

1. `rejudge.db.test.ts:57,67` 期望一个结果回执，得到两个；`:141` 在 resolution
   写入失败且 head/theta/cards 回滚后期望零，得到一个。`resolutions(appealId)`
   读取 appeal 的全部 caused_by 子项；额外项是先行提交的 operational binding。
   **这是业务结果因果面的污染，不能据此声称结算回滚失败。** 保留 helper 与所有断言。
2. `tests/dbos-judge/process.db.test.ts:923–956`：native-load-committed 后杀进程，
   native 已绑定 N、尚无 model claim；原 policy 允许介入的未激活 candidate 占 N，
   恢复 owner 固定 N 后命中 occupied guard，终态 manual，模型 wire=0。8d 的
   通用 native-binding floor 把介入者抬到 N+1，恢复 N 反而能花费，wire=3。
   **这是改变既有 fail-closed collision policy 的产品回归。** 保留 wire=0、
   单 evaluation、manual 三个断言，不重写 native/DBOS protocol。

### 窄化文件级修复方案（先记录、后产品编辑）

- 仅改 `server/assessment/appeal-execution.ts`：新 binding 的
  `caused_by_event_id=null`，通过不可变 bindingId 与 payload appeal_event_id、完整
  input/intent identity 定位。readback 的因果父项只接受 null 或恰为同一 appeal 的
  旧 8d 格式；action、subject、payload identity 的其他检查原样保留。旧 event 不改写。
- 同文件的 attempt floor 删除 `experimental:judge_execution_binding` 分支，只保留
  同 group/submission 的新申诉 binding 与历史 model claim。它仍作用于所有分配者，
  防止 B 或普通介入 candidate 占用 A 的申诉预留；native 仅 bind、尚未 claim 的
  槽位重新遵循原有可碰撞/恢复转 manual 的 policy。已有 paid claim 继续避位，
  无绑定历史申诉的 model hold 仍保留，不能从未知 claim 推导 fresh spend。
- `evaluate-submission.ts`、`rejudge.ts` 预计只读：binding replay、occupied guard、
  paid claim/result、精确 resolution action filter 不改。仅在证据要求时改必要接线。
- 本文及同 draft PR body 更新真实 CI 失败、最终源码顺序、旧 receipt 兼容和静态
  证据。P1-1/P1-2 保持 R2 CLOSED；P1-3 需修复后 parent 聚焦核验与最终 head QA。

测试/fixture/harness 全部只读，不新增、不删除、不改断言，不跑本机测试套件、DB、
queue、worker、services、containers、provider、TEST 或 paid action。只跑 typecheck、
lint:ratchet、build、相关静态 audits 与 git diff；push 触发新 head CI 已获授权。


### CI 修复结果与两个不变量的源码证明

本次产品 diff 只有 `assessment/appeal-execution.ts`，调用接线、production handler
精确 resolution filter、native protocol、occupied guard、extractor 与 frozen CAS 均未改。

- **结果因果面**：新 binding 仍由原 bindingId 定址，payload 的 appeal_event_id、
  group、submission、完整 revision/member/input snapshot、intent digest、attempt 和
  首次 admission snapshot 不变。新写入的 caused_by_event_id=null，结果子链只由原
  resolution writer 写入。其事务成功才产生业务子项；若 resolution writer 抛错，
  独立提交的 binding 可保留，但不会混入 `resolutions(appealId)`，没有把它解释成
  rollback 残留。旧 8d receipt 只允许 null 或**恰为同一 appeal id** 的旧 parent，
  其余 action/subject/payload 身份检查不放宽；不改写旧行，不另铸绑定身份。
  已存在的 8d 原因果边仍保留，不能声称历史数据已被清理。
- **native 预 claim crash/collision**：native 首次绑定 N、尚未 claim 就崩溃时，该
  binding 不再计入额外 attempt floor。现有测试的普通介入 candidate 因而按原策略
  占 N。native 重开虽会计算一个候选 nextAttempt，`bindJudgeExecution` 仍返回已存
  N，而不是采用新值；原 `if (binding)` occupied 查询在 evaluateSubmissionCore
  之前命中 evaluation(submission,N)，抛 attempt_conflict。原 judge_run handler
  把它当 permanent input_conflict 并记录 manual disposition；恢复不进入模型。
  因此保护目标仍是 wire=0、一个介入 evaluation、manual，三个原断言完整保留。
- **新 appeal A/B crash**：申诉绑定和历史 model claim 仍在所有分配者的上界内。
  A 的绑定 N 先提交，再 claim/pay N；B 看见 A 的申诉 reservation，使用 N+1。
  A 恢复优先读相同 bindingId，完整输入/意图匹配才返回 N，不采用 B 推高的 max+1。
  recorded executor 对原 group/submission/N/unit 查同 claim/result：sealed result
  重放，未知/无效/held 或不同 digest 保持 hold，不另发 paid identity。
- **历史与 caller 区分**：删除的是 native **仅绑定、未 claim** 的避位行为；真正
  model claim（无论原 native/appeal caller）仍避位。已有 native owner 重用自己的
  binding；无 binding 的历史 appeal 若创建后有无法归属的 claim，原持久 model hold
  判定未变，即便旧 result 已 sealed 也不从 fresh attempt 自动重买。未知 claim 不
  删除、不重置、不猜到另一 lane；新普通分配不会覆盖其槽位。确定性/人工断言保持原路。

以上为最终源码顺序论证，**不是重跑四条 DB 断言的结果**。测试和 fixture 的
`git diff --exit-code 8d301cc864f47187338cb191083686c79ceb8740 -- tests
':(glob)src/**/*.test.ts'` 实际 exit 0，空日志
`/private/tmp/yuk1407-ci-repair-tests-unchanged.log`；所有测试代码与断言字节未改。


### CI 修复本机检查与交付边界

本次以下全部实际 exit 0；日志前缀 `/private/tmp/yuk1407-ci-repair-`：

- `pnpm typecheck` → `typecheck.log`。
- touched-file Biome → `focused-lint.log`，零 errors/warnings。
- `pnpm lint:ratchet` → `lint-ratchet.log`，179 warnings / 0 infos，210/0 基线未改。
- `pnpm build` → `build.log`，只构建，不启动服务。
- `pnpm audit:schema` → `audit-schema.log`。
- `pnpm audit:capability-boundaries` → `audit-capability-boundaries.log`。
- `pnpm audit:architecture-deepening` → `audit-architecture-deepening.log`。
- `pnpm audit:structured-judge` → `audit-structured-judge.log`。
- `pnpm audit:provider-attempt-truth` → `audit-provider-attempt-truth.log`。
- `git diff --check` → `diff-check.log`。
- 上述 tests/fixture 不变 diff check → `tests-unchanged.log`（空，exit 0）。

不把本机静态通过写成 CI 修复已实测 PASS。原 exact-head 8d 的 CI 已知 FAILED，
本次只正常 commit/push 新源码、由新 head CI 执行既有断言；不 rerun 原 attempt。
P1-1/P1-2 仍为 sole R2 CLOSED；P1-3 与本次两项回归均待 parent 对最终产物核验。
无本机 testsuites/DB/queue/worker/services/containers/provider/TEST/paid/QA；原 8d QA
继续 HOLD，由 parent 对最终 head 更新实际 QA。未委派、未发 R3、未 merge、未写
Linear/root PLAN/.remember；代码 writer 在交付后释放。

## 真实作答的终态边界修复（2026-10-18；产品范围缺口，非新 review）

实际独占 writer cwd：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-efdff94d`。
初始为 T3 隔离树，旧协调 HEAD `4aec0845112df6dcda9951de0d64099a675718c8`。
先 `git fetch origin`；确认已发布 #1797 远端
`origin/fix/yuk-1407-process-answer-correction` 精确为
`22a02be1a8799b193792b34e7ce60b24d0fa7c18`，再从该提交创建唯一分支
`fix/yuk-1407-real-terminal-answer`，不带旧协调分支历史。
未写原作者树 `t3-eb173c3f` 或父树；仅正常本地 commit，由父 cherry-pick 回原 PR。
不 push、不新开 PR、不 merge、不委派、不启动 review。

### 父线实际验收输入与失败原因

父提供的真实历史题 `v1zkg2mrb3no3qc9ziv4fhov`，reference `11`，冻结作答全文：

> 由 a(n+1), a(n), a(n+2) 成等差数列，2a(n)=a(n+1)+a(n+2)，两边除以 a(n) 得 2=q+q²。q²+q-2=0，q=1 或 -2；q≠1，所以 q=-2。前五项是1,-2,4,-8,16，相加 S5=11。

父已通过真实 `/api/appeals` → rejudge 得到 pending needs_review，detail 为
`conflicting explicit final answers (q=-2。前五项是1,-2,4,-8,16,相加 S5=11。)`。
这是父提供的实际证据，本 lane 未重复页面或 DB 操作。

源码原因是旧结论正则把整条物理行内“所以”之后的所有句子当成一个值；
`q=-2。…相加 S5=11。` 包含两个等号，`candidateValues` 正确拒绝该复合候选。
错误在候选边界，而非比较器或申诉执行身份；不能靠取最后等号解决。

### 最小实现与源码论证（不是运行 PASS）

只改 `src/core/schema/judge-routing.ts` 的提取逻辑及本文，不改公开函数签名、
调用点、比较规则、appeal 身份/CAS/队列/receipt、准入/source_verify、UI/provider。
不需要新目标变量接口：目标标识符来自有明确末句边界的完整赋值本身。

1. 非答案声明行按换行和中文句号 `。` 识别完整过程句，末句的句号是语法边界。
   不按 ASCII 小数点、`!`、算符、等号或元组内部逗号拆值；`答/答案/最终答案`
   声明仍占有原整行，不能把 `答：北京。上海` 截成 `北京`。
2. 最终句继续接受原完整结论标记或完整赋值；另接受从句首或逗号/分号边界
   开始，由 `相加/可得/得到/得` 引出的**完整 identifier=value 从句**。
   肯定结果词本身不提取数字，也不放宽 RHS；整个候选仍经过原
   `candidateValues`。不是在任意 prose 中搜等号或 copula 后缀。
3. 此真实输入末句的合法从句为 `相加 S5=11`，所以唯一终态表述为
   `S5=11` 和其完整 RHS `11`，marker=`conclusion_marker`。此前“所以 q=-2”
   是不同变量的完整合法赋值，只用于识别中间量，不能加入可匹配候选。
   因而不会把 key `-2` 作为此作答的最终答案。此为源码推演，未调用提取函数。
4. 所有显式答案声明无条件参与一致性检查；此前完整同变量赋值、有标记的同变量结论、
   无法确定变量的完整结论、关系式/连等式不因最后出现可匹配值而消失。
   例如 `所以 S5=10。S5=11。`、`所以11。因此12` 仍冲突；变量比较沿用
   既有 NFKC/大小写规范化。新结果从句之前同句内有结论或完整同变量赋值时
   也保留其冲突检查，不能借 `得 S5=11` 隐藏此前完整的 `S5=10=11`。
5. 否定句不作 copula/RHS 子匹配：`所以答案不是11`、`所以答案不为11`、
   `所以结果不可能是11` 仍保留完整字符串；`不是S5=11` 不能匹配完整标识符
   赋值。关系字符继续拒绝；`S5=11!` 保留 `11!`，不能匹配 `11`；
   `S5=10=11` / `S5=1+2+8=11` 仍拒绝，不求值。
   `11*` 等被 answer-head 吞 token 的候选仍整体拒绝。
6. 父已实测的正例 `将 x=-2 代入 ax-6=2，得 -2a-6=2。\n所以 a=-4`
   按源码仍只提取末句 `a=-4` / `-4`；前句不进入终态候选。
   父报告的“判对1分、run_refs=[]”是旧 head 的实际证据，最终 head 仍须父复验。

已读手册及其指向的实际旧 R1/R2：
`/tmp/yuk1407-pr1797-review-40fc2e64a-r1.md`、
`/tmp/yuk1407-pr1797-verification-8720150a6-r2.md`。
本修复维持 R1 否定/比较/矛盾/数字碎片满分防护；不重开 R2 已结案事项，
不触及其申诉付费恢复风险路径，不宣称旧审查覆盖本次新 diff。

### 限制与父独占验收

不支持任意自然语言最终答案、无边界 prose 内嵌赋值、一般代数 LHS、
连等式求值、Markdown 边缘包装、单位或数学等价证明。除上述肯定结果词外
不猜其他 prose；末句没有完整语法就不回退选中间变量。ASCII 尾点仍不擅自
当句界剥除。显式答案声明行的尾句号仍按原完整值保护，不另做标点清洗。
此前完整同变量赋值若用另一种表达式（如 `S5=1+2+8` 后再写 `S5=11`），
没有共同完整候选时也会保守冲突，不用算式求值证明两者等价。
这是保守的提取语法，不证明整段推导正确，不增加模型或语义 fallback。

本 lane 不新增/修改测试、fixture、断言或合成脚本；不运行 vitest/full tests、
provider/DB/容器/TEST/服务；无 actual-output/真实页面运行结果。
真实历史题现时 withheld：不绕过准入，不声称能激活原库 head。
父须在其独占真实副本窗口核验完整冻结文本提取 `11` 并按原比较器比较，
以及既有 `a=-4` 正例、否定/比较/阶乘/矛盾/连等式反例；数据 hold 与提取修复
分开报告。此任务属于既有 YUK-1407 真实验收缺口，无额外新 follow-up；
Linear/PLAN/.remember 与 PR 的最终验收状态由父协调线统一维护。

### 本机静态检查与交回证据

实际 Node `v26.10.0` / pnpm `11.13.1`。隔离树初始无依赖，
`pnpm install --offline --frozen-lockfile --ignore-scripts` exit 0，未改 lockfile，
日志 `/private/tmp/yuk1407-real-terminal-install.log`。以下最终均实际 exit 0：

- `pnpm typecheck` → `/private/tmp/yuk1407-real-terminal-typecheck.log`。
- `pnpm lint:ratchet` → `/private/tmp/yuk1407-real-terminal-lint-ratchet.log`；
  179 warnings / 0 infos，210 / 0 基线未改。首次仅一处 regex 常量换行格式错误，
  已按 Biome 修正；失败日志保留为 `yuk1407-real-terminal-lint-ratchet-initial-failed.log`。
- `pnpm build` → `/private/tmp/yuk1407-real-terminal-build.log`；
  SPA / Start / server / worker / migrate 均仅构建，无服务启动。
- `pnpm audit:structured-judge` → `/private/tmp/yuk1407-real-terminal-audit-structured-judge.log`。
- `pnpm audit:provider-attempt-truth` → `/private/tmp/yuk1407-real-terminal-audit-provider-attempt-truth.log`。
- `pnpm audit:architecture-deepening` → `/private/tmp/yuk1407-real-terminal-audit-architecture-deepening.log`。
- `git diff --check` → `/private/tmp/yuk1407-real-terminal-diff-check.log`。
- 精确 base 下 tests / `*.test.*` / `*.spec.*` / fixtures 路径 diff 为空，
  exit 0 → `/private/tmp/yuk1407-real-terminal-tests-unchanged.log`。

完整实际差异将封存 `/private/tmp/yuk1407-real-terminal.patch`，提交身份与 clean-tree
状态封存 `/private/tmp/yuk1407-real-terminal-delivery.log`。这些静态结果不代表提取
actual-output、旧库 head 激活、真实 rejudge 或页面验收 PASS。提交后释放本树 writer，
由父核修并在其独占真实窗口复验，不再自行继续写入。

### 接续合并 origin/main（2026-10-19，merge `112b0f319`）

- 新接续分支 `yuk-1407-process-answer-resume` 基于固定原 head `8ffdd3ae6`，merge 最新 `origin/main`（`36b1346a0`）后正常推回 `fix/yuk-1407-process-answer-correction`；唯一冲突文件 `src/core/schema/assessment/evaluation.ts`（3 hunk）。
- 冲突裁断：全部保留 main 的 YUK-1568 K1 声明契约——`runDeterministicComparator` 增 `declaredShape` 形参、`gradeBlankExactUnit(unit, entry, declaredShape)`、分发点按冻结 slot 查 `answer_shape`；本 PR 的提取拦截挂在未声明文本空路径（`declaredShape == null` 门控），声明槽走共享比较核心 compareDeclaredBlank；`judged_by: executor.comparator` receipt 字段与 main 的声明传递并存。未回退任何 main 新声明。
- 本机静态门全绿：`pnpm typecheck` / `pnpm lint`（179 warnings，同基线）/ `pnpm build` exit 0；`biome check` 冲突文件 clean。未写/改任何测试，未跑 DB/容器/provider。
- 未复验：新 head 的 S5=11 / a=-4 真实页面与 DB 复验仍待父获批窗口；真实提取行为未变（拦截条件外加 `declaredShape == null`，未声明槽路径逐字保留）。

### glm 跨模型审查修复（2026-10-20）

- **assert accept 先效果后决策**：`acceptJudgeRetractionProposal` 仅在 `applyManualAssertCorrection` 成功后写 accept rate；确定性校验失败时写 `failed:<code>` resolution 并重新抛出，提案保持 pending，不再出现"已采纳但零效果、appeal 无结论"。
- **producer 预校验**：`writeEvaluationCorrectionProposal` 在落单时按冻结 revision + `projectIssuedScoringBasis` 校验 assert 全覆盖、unit 存在且 additive；工具将这类 `ApiError` 映射为 `rejected`，不落无效提案。
- **重判永久绑定冲突落 hold**：`rejudgeNativeAppeal` 对 `appeal_execution_conflict` / `attempt_conflict` / `evaluation_key_conflict` 写 `binding_conflict` resolution，不再只靠 pg-boss DLQ。
- **纠错提案原子去重**：producer 在写事务内先取 `proposal-cooldown` 咨询锁再复查 pending，同一 evaluation 的并发重复落单只保留一条，避免两次 accept 各跑一次同一冻结输入的付费重判。
- 同步修正 `proposal.ts` 中引用不存在测试的过时注释，以及 `proposal-appliers.ts` 的旧 judge_retraction 无 applier 描述。
- 本机 `pnpm typecheck` / `pnpm lint`（179 warnings，同基线）/ `pnpm build` exit 0；`audit:schema` / `audit:capability-boundaries` / `audit:architecture-deepening` / `audit:structured-judge` / `audit:test-policy` / `audit:provider-attempt-truth` 均 exit 0。未写/改测试，未跑 DB/queue/provider/真实页面。
