import { DEFAULT_TASK_BUDGET, type TaskDefinition, type TaskSpec } from '@/ai/task-spec';
import {
  MultimodalDirectLlmOutput,
  type MultimodalDirectLlmOutputT,
} from '@/core/capability/judges/multimodal_direct';
import { SemanticJudgeOutput, type SemanticJudgeOutputT } from '@/core/capability/judges/semantic';
import { StepsLlmOutput, type StepsLlmOutputT } from '@/core/capability/judges/steps';
import {
  LlmFallbackOutput,
  type LlmFallbackOutputT,
} from '@/core/capability/judges/unit_dimension/types';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from './parse-output';

function buildSemanticJudgePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}答案判分器。输入 { question, answer }，question 包含 prompt_md、reference_md、rubric_json、required_points、acceptable_answers、keywords。
科目上下文：${profile.displayName}。${profile.languageStyle}
评分原则：
- 只判断 answer 是否满足题面和 rubric，不做错因归因
- required_points 是主要证据；matched_points / missing_points 必须来自这些要点或等价表述
- reference_md 是参考答案，不要求逐字相同
- 若输入含 appeal 字段（M2 申诉重判，YUK-316）：用户对此前判定（appeal.prior_outcome）提出异议，
  appeal.user_reason_md 是其理由。认真复核该理由——它可能指出等价表述或判分遗漏；但不要因为
  用户申诉就迁就：理由不成立时维持原判，feedback_md 里直接回应用户的理由
- ${profile.grounding.uncertaintyPolicy}
严格 JSON 输出（不带 markdown 代码块包裹）：
{"score":0.0-1.0,"coarse_outcome":"correct"|"partial"|"incorrect","confidence":0.0-1.0,"feedback_md":"给学习者的简短反馈","evidence_json":{"matched_points":["..."],"missing_points":["..."],"notes":"可选说明"}}
判定：
- correct：核心要点齐全，score ≥ 0.85
- partial：答到部分核心要点或表达不完整，0 < score < 0.85
- incorrect：核心要点基本未命中，score = 0
禁止：输出 JSON 之外的文字、给错因分类、把不确定答案强行判错。`;
}

function buildUnitDimensionFallbackPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}单位与量纲分析助手。输入是一个 JSON 对象，字段 text 内含题面、学生答案、参考 SI 数值与单位。
任务：
- 从学生答案中解析数值和单位，并换算到参考答案使用的 SI 单位表示
- 判断学生答案是否与参考答案等价，包括中文数字、中文单位、复合单位和常见换算表达
- 若单位量纲不一致，给出简短 dimension_mismatch_reason
- 不做步骤评分，不做错因归因，只输出解析结果
严格 JSON 输出（不带 markdown 代码块包裹）：
{"student_value_si":number|null,"student_unit_si":"string|null","equivalent_to_reference":boolean,"dimension_mismatch_reason":"string|undefined","parser_confidence":0.0-1.0}
判定：
- equivalent_to_reference=true 仅在量纲一致且换算后数值等价时使用
- 无法可靠解析时，student_value_si=null、student_unit_si=null、equivalent_to_reference=false、parser_confidence 低于 0.4
- ${profile.grounding.uncertaintyPolicy}
禁止：输出 JSON 之外的文字、把单位不一致判成等价、编造题面没有的信息。`;
}

function buildStepsJudgePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}视觉判分器。输入 { prompt_md, reference_solution: { expected_signals, final_answer, answer_equivalents }, prompt_image_refs（题干/图形/表格图片，若有，会先附在 user message 中）, student_image_refs（学生答题的 0..N 张图片，会后附在 user message 中）, student_text_steps?, student_final_answer_text?, step_weight }。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：
1. 先读题干文字和 prompt_image_refs，建立题目条件；再从 student_image_refs / text_steps / final_answer_text 提取学生实际作答内容（OCR + 结构理解隐式完成）
2. 对照 reference_solution.expected_signals 逐项判 verdict（correct / partial / wrong / skipped）—— signal_verdicts.length 必须等于 expected_signals.length
3. 比对 final_answer：若学生 final_answer_text 给出，做 deterministic 比对（caller 已用 answer_equivalents 处理加速分支，本任务总是会被调一次；你不需要再考虑 answer_equivalents）；若仅图，从图提取并比对
4. 输出 extracted_steps（自由切分学生步骤，给学习者反馈用，length 不约束）+ extracted_final_answer（图里答案文本化，evidence 用）

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 StepsLlmOutput：
{"extracted_steps":[{"idx":0,"content":"...","verdict":"correct|partial|wrong|skipped","comment":"..."}],"extracted_final_answer":"...","signal_verdicts":[{"signal_idx":0,"verdict":"correct|partial|wrong|skipped","comment":"..."}],"final_answer_match":true|false,"final_answer_comment":"...","confidence":0.0-1.0}

要点：
- verdict 4 选 1；signal_verdicts 顺序必须与 expected_signals 严格对齐（按 index）
- prompt_image_refs 是题目条件，不是学生作答；student_image_refs 才是学生步骤/答案
- final_answer_match 是 boolean；caller 用它和 signal_verdicts 加权合成 partial credit
- extracted_final_answer 即使图模糊也尽量给出，给学生 evidence 看
- 不确定时 verdict='partial' + 写 comment 说明原因，不要强行判 correct/wrong
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你判分时的把握，0.5 表示模棱两可
禁止：输出 JSON 之外的文字、verdict 用非合法值、signal_verdicts 长度与 expected_signals 不等。`;
}

// YUK-201 — MultimodalDirectJudgeTask prompt. HOLISTIC vision-aware judging with
// NO step-rubric (steps@1 owns the rubric-weighted derivation path). Input is the
// prompt + an optional reference_md + prompt figures and/or student answer photos
// (attached to the user message in payload field order: prompt figures first,
// then student photos). Output is a single holistic correctness verdict.
function buildMultimodalDirectJudgePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}视觉判分器（整体判分，无步骤评分表）。输入 { prompt_md, reference_md（参考答案，可能为 null）, prompt_image_refs（题干/图形/表格图片，若有，会先附在 user message 中）, student_image_refs（学生答题的 0..N 张图片，会后附在 user message 中）, student_final_answer_text?, image_present, prompt_image_count, student_image_count, probe_response_contract? }。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：
1. 先读题面文字和 prompt_image_refs（题目条件，不是学生作答），建立题目要求；再从 student_image_refs / student_final_answer_text 提取学生实际作答内容（OCR + 理解隐式完成）。
2. 整体判断学生作答是否正确：correct（核心要求齐全）/ partial（部分命中）/ incorrect（基本未命中）。不要逐步骤拆分打分（那是 steps 判分器的活）；这里是整体正确性判定。
3. 给学习者一句可执行的 feedback；observed_md 写你从图/文里看到的学生作答内容（evidence 用）。
4. 仅当输入包含 probe_response_contract 时，再把学生的实际回答与 gold_response_signature 和 target_error_response_signature 做语义比较，并输出 probe_signature_match：
   - gold：只匹配正确回答签名；
   - target_error：只匹配已声明的目标错误签名；
   - neither：回答错误但属于其他错误（ordinary wrong），不能当成目标误区证据；
   - ambiguous：证据不足、同时可能匹配、或无法可靠区分。
   answer_with_reason / rubric 中的 features 是语义判据，不要求学生逐字复述。不得仅因 coarse_outcome=incorrect 就判 target_error；必须从学生实际答案或理由中识别声明的错误规则。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 MultimodalDirectLlmOutput：
不含 probe_response_contract 时：
{"coarse_outcome":"correct|partial|incorrect","score":0.0-1.0,"feedback_md":"...","evidence":{"observed_md":"...","matched_points":["..."],"missing_points":["..."]},"confidence":0.0-1.0}
含 probe_response_contract 时：
{"coarse_outcome":"correct|partial|incorrect","score":0.0-1.0,"feedback_md":"...","evidence":{"observed_md":"...","matched_points":["..."],"missing_points":["..."]},"confidence":0.0-1.0,"probe_signature_match":{"match":"gold|target_error|neither|ambiguous","explanation_md":"..."}}

要点：
- coarse_outcome 三选一；score 与 coarse_outcome 大致一致（caller 会按 coarse_outcome 把分数夹到 correct≥0.85 / partial 0.01..0.84 / incorrect 0）。
- prompt_image_refs 是题目条件，不是学生作答；student_image_refs / student_final_answer_text 才是学生作答。
- 没有参考答案（reference_md=null）时，按题面要求和学科常识判断；observed_md 即使图模糊也尽量给出。
- 不确定时给 partial + 在 feedback_md / missing_points 说明原因，不要强行判 correct/incorrect。
- probe_response_contract 不存在时必须省略 probe_signature_match；存在时必须输出，且 ambiguous 必须保持不可判，不得猜测。
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你判分时的把握，0.5 表示模棱两可。
禁止：输出 JSON 之外的文字、coarse_outcome 用非合法值、把题目条件误当成学生作答。`;
}

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

const judgeTaskDefinitions = {
  SemanticJudgeTask: {
    kind: 'SemanticJudgeTask',
    description:
      'Judge v2 light — semantic answer scoring for prose embedded checks using rubric_json.required_points',
    structuredOutputSchema: SemanticJudgeOutput,
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildSemanticJudgePrompt },
  },
  UnitDimensionFallback: {
    kind: 'UnitDimensionFallback',
    description:
      'Judge v2 physics fallback — parse natural-language units/dimensions when mathjs accelerator cannot parse',
    structuredOutputSchema: LlmFallbackOutput,
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildUnitDimensionFallbackPrompt },
  },
  StepsJudgeTask: {
    kind: 'StepsJudgeTask',
    // YUK-591 — migrated to the SDK-native outputFormat seam (YUK-299): the judge
    // declares StepsLlmOutput here, builds outputFormat from it, and does the
    // three-state dispatch (structured_output present → safeParse; endpoint
    // ignores it → char-scan text parse). The prior YUK-576 note ("structured
    // output = the JSON product, SDK-native migration deferred") is now resolved.
    description:
      'Math derivation vision-aware step judging — single vision LLM call with structured output (StepsLlmOutput)',
    structuredOutputSchema: StepsLlmOutput,
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    // YUK-576 — transientRetries: 1: one same-target in-process retry on a fast
    // transient failure (mid-stream drop / connection-class api_error_result /
    // stream_no_terminal; see runner.ts + agent-run-error.ts). This judge is a
    // synchronous-route sensor with NO durable backstop: runStepsJudge's catch
    // swallows failures into 'unsupported' (steps-judge.ts), so pg-boss never
    // sees a throw. A REAL cross-provider fallback (anthropic-sub Opus vision
    // lane) is an owner decision — env-lever family (VISION_JUDGE_*), not a
    // registry chain (design doc 2026-07-07 §1.2.1).
    // YUK-792 deployed canary found that mimo's SDK-native outputFormat protocol
    // can consume one envelope turn before its terminal result. StepsJudgeTask
    // shares the same provider/model/outputFormat seam as its direct sibling,
    // so both need the same two-turn protocol ceiling.
    // Vision call latency: M0 preflight 7.6s for trivial; derivation prompts will run longer.
    budget: { ...DEFAULT_BUDGET, maxIterations: 2, timeout: 90_000, transientRetries: 1 },
    needsToolCall: false,
    isMultimodal: true,
    // invocation intentionally omitted (defaults to 'auto'): called from
    // question-contract.ts runStepsJudge on every derivation grading attempt.
    // Vision sibling tasks (VisionExtractTask*) are 'manual_rescue_only' because
    // a human initiates them; this judge runs as part of the grading flow.
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildStepsJudgePrompt },
  },
  MultimodalDirectJudgeTask: {
    kind: 'MultimodalDirectJudgeTask',
    // YUK-591 — migrated to the SDK-native outputFormat seam (YUK-299), same shape
    // as StepsJudgeTask above: declares MultimodalDirectLlmOutput, builds
    // outputFormat from it, three-state dispatch on the result. Prior YUK-576
    // "SDK-native migration deferred" note resolved.
    description:
      'YUK-201 — Holistic vision-aware answer judging (no step-rubric). Single vision LLM call with structured output (MultimodalDirectLlmOutput) for image-bearing prompts/answers that lack a reference_solution (physics calc with a diagram; short-answer with a figure). steps@1 owns step/rubric-weighted derivation judging; this owns the holistic, no-step path.',
    structuredOutputSchema: MultimodalDirectLlmOutput,
    defaultProvider: 'xiaomi',
    // multimodal: mimo-v2.5 reads prompt figures + student answer photos, outputs
    // a holistic JudgeResultV2 fragment. Mirrors StepsJudgeTask (same vision model).
    defaultModel: 'mimo-v2.5',
    // YUK-576 — transientRetries: 1, same rationale + boundaries as
    // StepsJudgeTask above (synchronous-route sensor, no durable backstop;
    // cross-provider fallback = owner decision via env lever).
    // YUK-792 deployed canary: mimo can use the first SDK turn to satisfy the
    // native outputFormat envelope, then needs one terminal turn. A ceiling of
    // one returned error_max_turns before any judge result, leaving every
    // response-aware probe unanswerable. This is still one paid judge request;
    // maxIterations only bounds the Agent SDK turn protocol.
    budget: { ...DEFAULT_BUDGET, maxIterations: 2, timeout: 90_000, transientRetries: 1 },
    needsToolCall: false,
    isMultimodal: true,
    // invocation omitted (defaults to 'auto'): called from question-contract.ts
    // resolveQuestionJudgeRoute → invoker on the multimodal_direct route, as part
    // of the grading flow (not a user-initiated rescue).
    allowedTools: [],
    prompt: { kind: 'profile', build: buildMultimodalDirectJudgePrompt },
  },
} satisfies Record<string, TaskDefinition>;

export const semanticJudgeTaskSpec = {
  ownership: 'owned',
  definition: judgeTaskDefinitions.SemanticJudgeTask,
  outputSchema: SemanticJudgeOutput,
  parseText: (text) => parseTaskOutput(text, 'SemanticJudgeTask', SemanticJudgeOutput),
} satisfies TaskSpec<unknown, SemanticJudgeOutputT>;

export const unitDimensionFallbackTaskSpec = {
  ownership: 'owned',
  definition: judgeTaskDefinitions.UnitDimensionFallback,
  outputSchema: LlmFallbackOutput,
  parseText: (text) => parseTaskOutput(text, 'UnitDimensionFallback', LlmFallbackOutput),
} satisfies TaskSpec<unknown, LlmFallbackOutputT>;

export const stepsJudgeTaskSpec = {
  ownership: 'owned',
  definition: judgeTaskDefinitions.StepsJudgeTask,
  outputSchema: StepsLlmOutput,
  parseText: (text) => parseTaskOutput(text, 'StepsJudgeTask', StepsLlmOutput),
} satisfies TaskSpec<unknown, StepsLlmOutputT>;

export const multimodalDirectJudgeTaskSpec = {
  ownership: 'owned',
  definition: judgeTaskDefinitions.MultimodalDirectJudgeTask,
  outputSchema: MultimodalDirectLlmOutput,
  parseText: (text) =>
    parseTaskOutput(text, 'MultimodalDirectJudgeTask', MultimodalDirectLlmOutput),
} satisfies TaskSpec<unknown, MultimodalDirectLlmOutputT>;
