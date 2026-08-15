// YUK-879 — the three intervention-preparation task contracts, owned by the
// agency capability (YUK-791 / YUK-829 lineage). structuredOutputSchema stays on
// the definitions (same core/schema/intervention objects the central quarry
// referenced); ../server/intervention/recommend and the practice-side shared
// validator keep consuming them through the catalog projection. Prompt text is
// byte-identical to the former central quarry entries (prompt-hash oracle pins
// them).
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

// Legacy quarry alias preserved verbatim inside the moved definitions.
const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;
import {
  InterventionPackageReviewStructuredOutput,
  InterventionPackageStructuredOutput,
  PedagogyRecommendationStructuredOutput,
} from '@/core/schema/intervention';
import type { SubjectProfile } from '@/subjects/profile';
import type { z } from 'zod';
import { parseTaskOutput } from './parse-output';

function buildInterventionPackageAuthorPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}干预包作者。输入只有一个由服务端冻结的 intervention snapshot 和一条已通过 deterministic policy 的 pedagogy recommendation。你不能改写猜想、换教学法、补造历史或回退到普通 KC 题池。

一次输出完整、原子的 intervention package：
1. 一个教学材料 material；
2. immediate、delayed、transfer 各一道诊断题；
3. 三题都必须测试 snapshot.conjecture.claim_md 和 target_error_rule_md；
4. 每题都必须使用 response-aware probe_spec v2，明确 response_mode、gold_response_signature 和 target_error_response_signature；合法模式包括单选、多选、短答、答案加理由与 rubric 构造题，不要求二元选择；
5. expected_target_error_answer_md 是“若目标错误真的发生，会出现的明确错误回答”，必须可与 reference_md 区分，不能写成“任意错误/可能答错/无法判断”；
6. 两个 response signature 必须由题面和目标错误规则推出、在声明的响应模式下可评分且彼此可区分；若目标错误只会导致未定义响应、多个无法区分的被迫选择或随机猜测，必须改题；
7. immediate 与 delayed 测同一构念但题面不同；
8. transfer 必须更换真实情境，并在 context_change_md 明说换了什么；
9. 题目必须可独立判分，不得在题干泄露 reference 或目标错误答案。

方法必须严格落实 recommendation.method_id、rationale_md 和 safety_constraints。只用输入里的学科事实与证据；证据不足宁可让整次生成失败，也不能发明概念、公式、原文或因果效果。

严格 JSON 输出（不带 markdown 代码块）：
{"schema_version":1,"material":{"title_md":"...","body_md":"..."},"diagnostics":{"immediate":{"kind":"immediate","probe_spec":{"schema_version":2,"prompt_md":"...","reference_md":"...","expected_target_error_answer_md":"...","elicits_target_error_reason_md":"...","context_kind":"abstract","representation_kind":"symbolic","response_mode":"short_answer","gold_response_signature":{"kind":"text","response_md":"..."},"target_error_response_signature":{"kind":"text","response_md":"..."}},"tested_claim_md":"<逐字复制 claim_md>","target_error_rule_md":"<逐字复制 target_error_rule_md>"},"delayed":{"kind":"delayed","probe_spec":{"schema_version":2,"prompt_md":"...","reference_md":"...","expected_target_error_answer_md":"...","elicits_target_error_reason_md":"...","context_kind":"abstract","representation_kind":"natural_language","response_mode":"answer_with_reason","gold_response_signature":{"kind":"answer_with_reason","answer_md":"...","required_reason_features_md":["..."]},"target_error_response_signature":{"kind":"answer_with_reason","answer_md":"...","required_reason_features_md":["..."]}},"tested_claim_md":"<逐字复制 claim_md>","target_error_rule_md":"<逐字复制 target_error_rule_md>"},"transfer":{"kind":"transfer","probe_spec":{"schema_version":2,"prompt_md":"...","reference_md":"...","expected_target_error_answer_md":"...","elicits_target_error_reason_md":"...","context_kind":"applied","representation_kind":"natural_language","response_mode":"short_answer","gold_response_signature":{"kind":"text","response_md":"..."},"target_error_response_signature":{"kind":"text","response_md":"..."}},"tested_claim_md":"<逐字复制 claim_md>","target_error_rule_md":"<逐字复制 target_error_rule_md>","context_change_md":"..."}}}

科目表达：${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}`;
}

function buildInterventionPackageReviewPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}干预包的比较审查员。作者调用已经结束；在你之前，系统已复用现有题目 validator 的两个独立阶段：(a) 对 immediate、delayed、transfer 三道题分别只看题面完成盲解；(b) 用 release_strict policy 分别核验题面/reference 的 factual grounding。输入中的 sealed_independent_solutions 是盲解密封结果；sealed_question_content_validations 是 grounding 密封结果。你不得把作者 reference、gold signature、教学材料或冻结 claim 当成盲解来源，不得改写、替换或伪造任何密封结果，也不得用盲解一致性推翻 grounding 的 unclear/fail。

输入含 immutable snapshot（conjecture.diagnostic_spec 已冻结）、pedagogy recommendation、完整 package candidate、server-owned review_requirements，以及恰好三份 sealed_independent_solutions。按 kind 一一对应后审查：

1. **参考答案与学科 grounding**：用密封盲解中的 final_answer_md、answer_equivalents_md、expected_signals_md、worked_solution_md 对照 package 的 reference_md / gold_response_signature。密封盲解只证明“另一模型怎样按题面求解”，**不是题面事实、引文解读或因果分类的权威来源**。同 kind 的 sealed_question_content_validations.grounding 不是 pass 时 discipline_grounded 必须 false；服务端还会执行同一 hard gate，你不能覆盖。题目所问量、量纲、计算、文本方向、因果定义、唯一性或签名有任一不匹配，reference_correct=false。题面明确标为匿名记录/假设数据时可把记录作为 givens；但具名真实作品、人物、史实、公式出处及作者附带 gloss 不是 givens，必须对照所引文字和本学科知识判断。数学、文本、引用、事实或因果方向缺乏可靠依据时 discipline_grounded=false；严重事实错误同时令 serious_factual_error_absent=false。snapshot 的 scope boundary 只限制被测 claim，绝不能豁免 package 的 factuality/material grounding。
2. **冻结范围**：先确定题目最终要求回答的量或结论，再把完整必要解题路径中的每份 sealed_independent_solutions.required_operations（由盲解 expected_signals 密封生成）逐项对照 snapshot.conjecture.claim_md、diagnostic_spec.trigger_conditions_md 与 scope_boundary_md。每个 operation 只按输入顺序原样复制 operation_index，并分别输出 reference_covers_operation、within_frozen_scope、decision_basis_md；不得输出或猜测 operation_sha256/operation_md，它们由服务端按 kind+index 密封绑定。不得漏项、并项或只审局部。诊断级 within_frozen_scope 是全部 operation 的 all-of 判据：即使某个局部子步骤命中冻结 claim，只要任一步需要 scope_boundary_md 排除、或冻结 claim 未覆盖的运算、概念、文本语境或因果方向，就必须置 false 并报 claim_scope_expansion。任一步未被 reference 覆盖则 reference_correct=false 并报 reference_incorrect。tested_claim_md 的逐字相等不能推翻内容审查；review_requirements.audit_entire_solution_path=true 也不得被忽略。
3. **因果方向**：每题必须输出 causal_direction_check。输入的 reference_reverse_causation_claims 是服务端仅从 reference_md 与 gold signature 提取并密封的明确反向因果主张；它的存在性、claim_index、source_path、claim_md、claim_sha256 都不是你能否认或改写的。你只按原顺序为**每一条**输出同 index 的 relation 与简短依据，不得漏项、并项、重排或额外添加。review_requirements.causal_direction_required=true 或该题 claims 非空时，applies 必须为 true，并从题面定义 X 与 outcome construct / estimand Y；置 false 属于合同错误。真正的非因果题且 claims 为空才把 applies=false、X/Y 填空串、relations 给空数组。因果题 shape：
{"applies":true,"exposure_x_md":"treatment/exposure X","observed_outcome_y_md":"题面 outcome construct / estimand Y","reference_reverse_causation_claim_relations":[{"claim_index":0,"relation":"same_outcome_construct_y|baseline_or_prior_different_construct|common_cause_or_other_or_unclear","decision_basis_md":"..."}]}
reverse causation 指**同一个 outcome construct / estimand Y** 影响 X，不以“发生在 X 前后”或 reference 自称“反向因果”作为证明：例如题面 Y=当前抑郁严重度时，较高抑郁严重度降低运动 X，归 same_outcome_construct_y。若题面 Y 是变化量 ΔY（成绩提高幅度、血压变化等），基线水平 Y0、能力/“提升潜力”、动机、倾向、预期改善都不是 ΔY；它们驱动 X 时归 baseline_or_prior_different_construct 或 common_cause_or_other_or_unclear。共同原因、购买意图影响网站访问但题面 Y=实际购买量等不同构念，也归 common_cause_or_other_or_unclear。任一 server-owned claim 不是 same_outcome_construct_y，就必须 reference_correct=false、discipline_grounded=false。claim presence/text/digest 与最终兼容 bit 均由服务端绑定，你不得输出。

完成三题比较后，再逐项检查：
- material 是否只使用证据支持的学科事实，且真实落实 recommendation.method_id 与 safety_constraints；
- 三题 tested_claim_md / target_error_rule_md 是否与 snapshot 完全一致；
- response_mode 与两种 signature 是否匹配，gold/target 是否分别由正确规则和目标错误规则推出、可评分、可区分；
- 答案是否唯一、可判定、无泄题；expected_target_error_answer_md 是否明确对应目标错误；
- immediate/delayed 是否同构念但非同题；transfer 是否真正更换情境且仍测试同一 claim；
- 是否有严重事实错误或不安全内容。

把这些包级结论逐项写入 package_checks；布尔字段不是摘要意见，而是 server 会据此映射 failure code 的承重判据：material_grounded、method_followed、tested_claims_match、target_errors_match、answers_unique、answers_gradable、no_answer_leak、diagnostics_same_construct、transfer_context_changed、target_error_identifiable、serious_factual_error_absent、safe_material。不得用 verdict=pass 覆盖任何 false。

每种 kind 恰好一次。服务端按 kind 绑定对应密封 solver digest、按 operation_index 绑定每个 operation digest/原文，并从你给出的承重布尔值与 claim relations 独立派生闭集 failure codes 和最终 verdict；你不得输出 verdict、failure_codes 或 provenance 字段。diagnostic_checks 也不输出独立答案或必要步骤文本。decision_basis_md 只写比较结论的必要依据，不复述完整题面/reference，不给修题建议，不输出探索过程。summary_md 最长 2000 字符。

只输出恰好一个严格 JSON object；不带 markdown 代码块，不要输出第二版或 JSON 外文字。输出完最后一个 } 立即停止：
{"review_protocol_version":2,"diagnostic_checks":[{"kind":"immediate|delayed|transfer","required_operation_checks":[{"operation_index":0,"reference_covers_operation":true,"within_frozen_scope":true,"decision_basis_md":"..."}],"reference_correct":true,"within_frozen_scope":true,"discipline_grounded":true,"decision_basis_md":"...","causal_direction_check":{"applies":false,"exposure_x_md":"","observed_outcome_y_md":"","reference_reverse_causation_claim_relations":[]}}],"package_checks":{"material_grounded":true,"method_followed":true,"tested_claims_match":true,"target_errors_match":true,"answers_unique":true,"answers_gradable":true,"no_answer_leak":true,"diagnostics_same_construct":true,"transfer_context_changed":true,"target_error_identifiable":true,"serious_factual_error_absent":true,"safe_material":true},"summary_md":"..."}

证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}`;
}

export function parseInterventionRecommendationOutput(
  text: string,
): z.infer<typeof PedagogyRecommendationStructuredOutput> {
  return parseTaskOutput(
    text,
    'InterventionRecommendationTask',
    PedagogyRecommendationStructuredOutput,
  );
}

export const interventionRecommendationTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'InterventionRecommendationTask',
    description:
      'Selects one method from the server-provided deterministic pedagogy shortlist, or abstains. It cannot restore an excluded/disabled method and does not claim causal method efficacy.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    structuredOutputSchema: PedagogyRecommendationStructuredOutput,
    prompt: {
      kind: 'inline',
      text: `You are the single pedagogy recommendation stage inside an intervention preparation wave. Input contains an immutable conjecture/learner snapshot, deterministic candidate method definitions, exclusions, and prior interventions.

Choose exactly one candidate method only when the evidence supports a safe choice. Never select a method outside candidates, never restore a disabled or contraindicated method, never invent learner history, and never claim a causal ranking between methods. rationale_md must explain why this legal method fits this snapshot. safety_constraints must be concrete constraints the package author can follow.

If grounding is insufficient or prior outcomes conflict, abstain. Do not output no_safe_method: the server handles an empty shortlist without calling you.

Strict JSON only:
{"kind":"recommendation","method_id":"<candidate id>","rationale_md":"...","safety_constraints":["..."]}
or
{"kind":"abstain","reason_code":"insufficient_grounding"|"conflicting_history","detail_md":"..."}`,
    },
  },
  outputSchema: PedagogyRecommendationStructuredOutput,
  parseText: parseInterventionRecommendationOutput,
} satisfies TaskSpec<unknown, unknown>;

export const interventionPackageAuthorTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'InterventionPackageAuthorTask',
    description:
      'Authors one atomic intervention package: one teaching material plus immediate, delayed, and transfer diagnostics, all bound to the frozen claim, target error, and selected method.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    // YUK-814 Gate C measured one valid 7,178-token package at 117.1s, then
    // observed two consecutive SDK aborts at the former 120s ceiling. Preserve
    // the bounded two-turn contract while allowing the structured output to land.
    budget: { ...DEFAULT_BUDGET, maxIterations: 2, timeout: 180_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    structuredOutputSchema: InterventionPackageStructuredOutput,
    prompt: { kind: 'profile', build: buildInterventionPackageAuthorPrompt },
  },
  outputSchema: InterventionPackageStructuredOutput,
  parseText: (text) =>
    parseTaskOutput(text, 'InterventionPackageAuthorTask', InterventionPackageStructuredOutput),
} satisfies TaskSpec<unknown, unknown>;

export const interventionPackageReviewTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'InterventionPackageReviewTask',
    description:
      'Compares a complete intervention package with three sealed outputs from the shared independent question validator. Returns bounded diagnostic/package checks and never repairs or partially activates the package.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    // The comparator receives three worked blind solutions plus the package, so
    // keep the measured 180s envelope even though it no longer solves them itself.
    budget: { ...DEFAULT_BUDGET, maxIterations: 2, timeout: 180_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    structuredOutputSchema: InterventionPackageReviewStructuredOutput,
    prompt: { kind: 'profile', build: buildInterventionPackageReviewPrompt },
  },
  outputSchema: InterventionPackageReviewStructuredOutput,
  parseText: (text) =>
    parseTaskOutput(
      text,
      'InterventionPackageReviewTask',
      InterventionPackageReviewStructuredOutput,
    ),
} satisfies TaskSpec<unknown, unknown>;
