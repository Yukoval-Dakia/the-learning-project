// The two intervention-preparation task contracts. structuredOutputSchema
// stays on the definitions; the recommend orchestrator
// (../server/intervention/recommend) and the practice-side shared validator
// consume them through the catalog projection.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

import type { z } from 'zod';
import {
  InterventionPackageStructuredOutput,
  PedagogyRecommendationStructuredOutput,
} from '@/core/schema/intervention';
import type { SubjectProfile } from '@/subjects/profile';
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
    budget: { ...DEFAULT_BUDGET, maxIterations: 1 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    structuredOutputSchema: PedagogyRecommendationStructuredOutput,
    context: {
      view: 'none',
      reason: '干预推荐与题目准备按干预快照及诊断输入装配，不读学习者画像 view。',
    },

    prompt: {
      kind: 'inline',
      text: `You are the single pedagogy recommendation stage inside an intervention preparation wave. Input contains an immutable conjecture/learner snapshot, deterministic candidate method definitions, exclusions, and prior interventions.

Choose exactly one candidate method only when the evidence supports a safe choice. Never select a method outside candidates, never restore a disabled or contraindicated method, never invent learner history, and never claim a causal ranking between methods. rationale_md must explain why this legal method fits this snapshot. safety_constraints must be concrete constraints the package author can follow.

When input sets sole_candidate=true, the deterministic policy has already narrowed the shortlist to exactly one legal method: your only decision is whether to abstain or accept that method (method_id must equal the sole candidate). Do not compare alternatives or rank methods in that case.

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
    // Measured: one valid 7,178-token package at 117.1s, then two consecutive SDK
    // aborts at the old 120s cap. Keep the bounded two-turn contract and let output land.
    budget: { ...DEFAULT_BUDGET, maxIterations: 2, timeout: 180_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    structuredOutputSchema: InterventionPackageStructuredOutput,
    context: {
      view: 'none',
      reason: '干预推荐与题目准备按干预快照及诊断输入装配，不读学习者画像 view。',
    },

    prompt: { kind: 'profile', build: buildInterventionPackageAuthorPrompt },
  },
  outputSchema: InterventionPackageStructuredOutput,
  parseText: (text) =>
    parseTaskOutput(text, 'InterventionPackageAuthorTask', InterventionPackageStructuredOutput),
} satisfies TaskSpec<unknown, unknown>;
