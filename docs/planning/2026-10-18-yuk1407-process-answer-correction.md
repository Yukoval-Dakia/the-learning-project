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

`src/core/schema/judge-routing.ts` 新增：
- `extractFinalAnswer(text)`：从过程文本提取**明确**终态结论 —
  显式 `答：/答案：/所以/因此/故/综上/即/∴` 结论标记行、末段结论从句、
  末行尾随 `X = v` 等式右侧；多个互相矛盾的候选 → `ambiguous`；
  找不到 → `none`。不含"最后一个数字"之类的弱启发式。
- **不安全提取守卫（R1 review）**：捕获值含否定（不是/不等/不得/并非）、
  比较符（< > ≤ ≥ ≠ !=）或行内多重等号（`S5=10=11`）⇒ 整体 `ambiguous`
  —— 确定性契约无法证明语义时保守未决，绝不把「答案不是11」经 copula
  剥成「11」给满分，也不把矛盾等式链的末环当终态。
- `isProcessLikeAnswer(text)`：多行/多句段、含推导标记或超出短答长度的
  文本视为"过程作答"。

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
