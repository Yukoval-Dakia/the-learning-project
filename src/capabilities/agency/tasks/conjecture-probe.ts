// YUK-879 — ConjectureProbeAuthorTask + ConjectureProbeReviewTask contracts,
// owned by the agency capability (YUK-821 response-aware probe quality gate).
// Envelope schemas are the single source the probe-quality orchestrator
// (../server/conjecture/probe-quality) feeds to zodToJsonSchemaOutputFormat.
// Prompt text is byte-identical to the former central quarry entries
// (prompt-hash oracle pins them).
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

// Legacy quarry alias preserved verbatim inside the moved definitions.
const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;
import { ConjectureProbePackageV2, ConjectureProbeReview } from '@/core/schema/business';
import type { SubjectProfile } from '@/subjects/profile';
import { z } from 'zod';
import { parseTaskOutput } from './parse-output';

export const ConjectureProbeAuthorOutputSchema = z.object({
  package: ConjectureProbePackageV2,
});
export type ConjectureProbeAuthorOutput = z.infer<typeof ConjectureProbeAuthorOutputSchema>;

export const ConjectureProbeReviewOutputSchema = z.object({
  review: ConjectureProbeReview,
});
export type ConjectureProbeReviewOutput = z.infer<typeof ConjectureProbeReviewOutputSchema>;

export function parseConjectureProbeAuthorOutput(text: string): ConjectureProbeAuthorOutput {
  return parseTaskOutput(text, 'ConjectureProbeAuthorTask', ConjectureProbeAuthorOutputSchema);
}

export function parseConjectureProbeReviewOutput(text: string): ConjectureProbeReviewOutput {
  return parseTaskOutput(text, 'ConjectureProbeReviewTask', ConjectureProbeReviewOutputSchema);
}

function buildConjectureProbeAuthorPrompt(profile: SubjectProfile): string {
  return `你是诊断探针出题器。输入包含 frozen_hypothesis（已由多样本共识冻结的 claim + DiagnosticSpec）、原始 evidence、generation_attempt，以及重试时的 prior_quality_failures。

科目上下文：${profile.displayName}。${profile.languageStyle}

你的唯一任务是依据 frozen_hypothesis 生成恰好两道未教学诊断题。不得修改、扩张或“优化” claim/DiagnosticSpec：
- 两题都必须保留 diagnostic_spec.trigger_conditions_md，并能诱发同一个 target_error_rule_md。
- 每题必须给出完整 reference_md，以及按目标错误规则作答时会出现的 expected_target_error_answer_md；两者不得相同。
- 每题必须声明 response_mode、gold_response_signature 和 target_error_response_signature。签名描述可实际评分的 learner response，而不是作者的泛化解释。
- elicits_target_error_reason_md 要说明这道题为何能区分目标错误，而不是泛泛说“考查知识点”。
- 两题的 context_kind 和 representation_kind 两个字段都必须改变；不能只换数字。若
  prior_quality_failures 含 probe_pair_not_independent，下一版必须同时修复这两个字段。
- context_kind / representation_kind 必须忠实描述题面实际结构，不能只改标签制造独立性：
  representation_kind=table 时 prompt_md 必须真的含有可读表格；multiple_choice 必须真的
  含选项；natural_language 才能描述纯文字问答。
- 不照抄 evidence 原题，不教学、不提示正确规则。
- 只使用输入证据中的科目、知识点和术语，不引入无来源题材。
- 输入没有实际图片/图表附件时，不得写“下图”“如图”或把 representation_kind 设为
  diagram/image；需要视觉变化时改用题干内完整呈现的 table/data。
- 不是所有探针都必须是二元或单选。response_mode 可用 single_choice、multiple_select、
  short_answer、answer_with_reason、constructed_response；选择最能区分 gold 与目标错误的模式。
- 若使用单选题，必须先独立解完每个选项，确保恰好一个正确选项；gold 和目标错误签名
  也必须各自唯一落到一个选项。若目标错误只会导致“无答案”“A/B/D 任一”或随机猜，
  不得强行指定一个错项；改用 multiple_select、answer_with_reason、constructed_response，
  或重写题目使两种响应都可识别。
- choice 签名同时服务 single_choice 和 multiple_select；多选题题干必须明确“可多选”，
  且 option_ids 集合与题干、reference 完全一致。
- multiple_select 必须把每个选项分别在「正确规则」和「target_error_rule」下重算：
  gold_response_signature 是正确规则会选出的完整集合，target_error_response_signature
  是目标错误规则会选出的完整集合。两者独立产生，禁止把 gold 集合与目标错项做并集。
- 化简后等价、语义上同样成立的选项也算多个正确选项，必须重写，不能在 reference 里
  把它们解释成“都对”。
- reference 必须与题干的作答口径一致：题干说“哪一个/正确的一项”时，reference 只能
  给一个答案；题干条件、计算过程和结论不得互相矛盾。
- 输出前必须重新独立解两题，并逐一核对 reference 的开头结论、后续计算/论证、
  gold_response_signature 三者完全一致；禁止保留“等等/重新计算/前面答案有误”等草稿痕迹。
- 优先生成条件少、可独立复算的自包含题。reference 只保留清洁的最终答案和一条已验证
  推导，不展示探索过程，不得擅自改写题干条件来让答案成立。若表格/数据题需要查值，
  题干必须真的给出所需行或所需数据。
- text.response_md / answer_with_reason / rubric 是给语义 Judge 的判据或代表性答案，
  不是逐字相等模板。分数化简、等值公式或同义表述仍可命中同一签名；用签名描述
  稳定的答案语义，不要因同一规则可能有等价写法就随意选择一个不完整的字面变体。
- predicted_p 是“若猜想成立，owner 答对 primary 的概率”，取 0..1。

context_kind 只能是 abstract/applied/narrative/document/visual/data/code/other。
representation_kind 只能是 symbolic/natural_language/multiple_choice/table/diagram/graph/image/code/mixed/other。
choice 签名格式为 {"kind":"choice","option_ids":["A"]}；short_answer 用
{"kind":"text","response_md":"..."}；answer_with_reason 用
{"kind":"answer_with_reason","answer_md":"...","required_reason_features_md":["..."]}；
constructed_response 用 {"kind":"rubric","required_features_md":["..."]}。

只输出 JSON，不输出 markdown 或推理过程：
{"package":{"primary":{"schema_version":2,"prompt_md":"...","reference_md":"...","expected_target_error_answer_md":"...","elicits_target_error_reason_md":"...","context_kind":"...","representation_kind":"...","response_mode":"...","gold_response_signature":{"kind":"..."},"target_error_response_signature":{"kind":"..."}},"followup":{"schema_version":2,"prompt_md":"...","reference_md":"...","expected_target_error_answer_md":"...","elicits_target_error_reason_md":"...","context_kind":"...","representation_kind":"...","response_mode":"...","gold_response_signature":{"kind":"..."},"target_error_response_signature":{"kind":"..."}},"predicted_p":<0..1>}}`;
}

function buildConjectureProbeReviewPrompt(profile: SubjectProfile): string {
  return `你是独立诊断探针审查员。你没有参与出题。输入包含 frozen_hypothesis、原始 evidence、probe_package。

科目上下文：${profile.displayName}。${profile.languageStyle}

逐项审查，宁可 fail，不得替作者修题：
1. claim_scope_expansion：题目或解释是否超出 evidence 与 scope_boundary。
2. probe_not_targeting：任一道题是否丢失 trigger_conditions，或其预期错误答案不能由 target_error_rule 推出。
3. probe_pair_not_independent：两题是否只是换数字，或情境/表征没有真正改变。
4. reference_incorrect：题目是否不可判定，reference 是否错误、不唯一或不配套。
5. target_error_answer_not_distinct：预期目标错误答案是否与正确答案相同。

先复核 frozen_hypothesis.diagnostic_spec.causal_direction_required：只要冻结 claim / target_error_rule / trigger 涉及 X 导致、引起、造成 Y、由相关推因果、反向因果或共同原因，该值必须为 true；若被错误写成 false，按 claim_scope_expansion fail，不能让后续因果审查消失。

执行第 4 项时必须先独立解题，再看 reference：
- 同时核对 response_mode、gold_response_signature、target_error_response_signature 是否与题干、
  reference、目标错误规则一致，并能从 learner response 中区分两类结果。
- 不是要求所有探针都做成二元选择；multiple_select、answer_with_reason、
  constructed_response 都可以。关键是两种响应签名都可判定且互不混淆。
- choice 是单选和多选共用的签名 kind，不能因为 kind=choice 就把
  response_mode=multiple_select 判错；应检查题干是否明确多选以及 option_ids 集合。
- 审查 multiple_select 时，必须列举每个选项并分别套用正确规则与 target_error_rule，
  独立重算 gold 集合和 target-error 集合；若作者把正确项保留后再并入目标错项，
  或漏选目标错误规则实际会选择的项，必须 probe_not_targeting。
- 输入中不存在的图片、图表或“下图”引用一律 reference_incorrect；纯文字完整描述的
  table/data 不算缺图。
- 不信任作者自报的 context_kind / representation_kind；必须直接看两道 prompt 的实际
  结构。纯文字题即使标成 table 也不构成表征变化，只有题面真的包含表格/选项/符号结构
  才能据此认定独立，否则 probe_pair_not_independent。
- 单选措辞（“哪一个”“正确的一项”“选择正确答案”等）必须逐项判断每个选项，且恰好
  一个正确；零个或多个正确选项一律 reference_incorrect。
- 单选题若目标错误规则只能推出“无答案”“多个可能选项”或随机猜，却人为把
  target_error_response_signature 绑定到某一个错项，必须 probe_not_targeting。
- 单选题中，只有 target_error_response_signature 指定的目标错项必须由
  target_error_rule 推出；其他普通干扰项只需明确错误且不与 gold/target 签名混淆，
  不要求每个普通干扰项都来自本次目标误区。不得因为一个非目标干扰项没有对应
  target_error_rule，就把整题判为 probe_not_targeting。
- 代数化简后等价、或语义上同时成立的选项仍算多个正确选项。即使 reference 自己承认
  多个选项正确，也不能 pass，因为题干要求唯一答案。
- reference 的条件、步骤、算术、选项判定或最终结论只要互相矛盾，就必须 fail，不能
  因为其中某一句正确而放过整题。
- text.response_md / answer_with_reason / rubric 由语义 Judge 匹配，不是逐字字符串比较。
  若学习者把同一个目标错误结果做了约分、等值变形或同义改写，不要仅因字面不同就判
  reference_incorrect；应检查签名描述的答案语义是否仍唯一对应 gold 或 target_error。

全部通过才 verdict=pass 且 failure_codes=[]；任一失败则 verdict=fail，列出所有适用代码。只输出 JSON：
{"review":{"verdict":"pass|fail","failure_codes":["..."],"explanation_md":"..."}}`;
}

export const conjectureProbeAuthorTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'ConjectureProbeAuthorTask',
    description:
      'Authors one complete two-probe package from a frozen evidence-grounded DiagnosticSpec, including gold and expected target-error answers.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    // Nightly/background path. Fixed-batch runs showed valid structured output
    // occasionally arriving after the former 120s wall-clock ceiling.
    budget: { ...DEFAULT_BUDGET, maxIterations: 3, timeout: 180_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildConjectureProbeAuthorPrompt },
  },
  outputSchema: ConjectureProbeAuthorOutputSchema,
  parseText: parseConjectureProbeAuthorOutput,
} satisfies TaskSpec<unknown, ConjectureProbeAuthorOutput>;

export const conjectureProbeReviewTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'ConjectureProbeReviewTask',
    description:
      'Independently reviews a conjecture probe pair against evidence and a frozen DiagnosticSpec. It returns pass/failure codes and never repairs the pair.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 3, timeout: 180_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildConjectureProbeReviewPrompt },
  },
  outputSchema: ConjectureProbeReviewOutputSchema,
  parseText: parseConjectureProbeReviewOutput,
} satisfies TaskSpec<unknown, ConjectureProbeReviewOutput>;
