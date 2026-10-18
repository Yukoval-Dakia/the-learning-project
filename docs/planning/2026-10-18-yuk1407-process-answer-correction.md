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

- `extractFinalAnswer(text)` 只接受完整答案声明行，或最后非空行中从
  行首/中文句号/逗号/分号开始的 `所以/因此/故/综上/即/∴` 结论从句；
  无标记时只认**完整末行** `identifier = value`。identifier 限 ASCII/希腊
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
- 多个不相容明示结论 → `ambiguous`；无明确语法 → `none`。
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
    窗口内去重；窗口外 dup job 由 handler `appealAlreadyResolved` + activation
    CAS 幂等兜底）再判定完成 —— crash 于 event/rate 任一阶段都能安全续投。
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
  包装的提取。带尾句号等会被现有 answer-head 改写的提取也保守拒绝；
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
