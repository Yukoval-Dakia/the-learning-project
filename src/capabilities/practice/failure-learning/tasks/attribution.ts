import { z } from 'zod';
import { causeIdList, causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import {
  BloomLevel,
  CauseSchema,
  type CauseSchemaT,
  MetaCause,
  type MetaCauseFieldsT,
  MetacogFlag,
  getMetaCausePrior,
  validateCauseAgainstProfile,
} from '@/core/schema/business';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import type { AttributionEvidence } from './attribution-evidence';

export interface AttributionInput extends AttributionEvidence {
  prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string;
  knowledge_context: Array<{ id: string; name: string; effective_domain: string | null }>;
  reasoning_trace_md?: string | null;
}

export type AttributionCandidate = SubjectProfile['causeCategories'][number];

export interface AttributionRerankInput extends AttributionInput {
  candidates: AttributionCandidate[];
}

export const AttributionOutputSchema = CauseSchema.extend({
  analysis_md: z.string().min(1).max(2000),
});

export type AttributionOutput = Omit<CauseSchemaT, keyof MetaCauseFieldsT> & MetaCauseFieldsT;

export function parseAttributionOutput(
  text: string,
  profile: SubjectProfile = resolveSubjectProfile(),
): AttributionOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseAttributionOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (error) {
    throw new Error(`parseAttributionOutput: JSON.parse failed: ${(error as Error).message}`);
  }
  const parsed = validateCauseAgainstProfile(AttributionOutputSchema.parse(json), profile);
  return {
    ...parsed,
    // Cold-start prior comes from the subject's own category declaration.
    meta_cause:
      parsed.meta_cause === undefined
        ? getMetaCausePrior(profile, parsed.primary_category)
        : parsed.meta_cause,
    meta_cause_secondary: parsed.meta_cause_secondary ?? null,
    metacog_flag: parsed.metacog_flag ?? null,
    bloom_level: parsed.bloom_level ?? null,
    self_corrected_on_hint: parsed.self_corrected_on_hint ?? null,
    recurred_cross_item: parsed.recurred_cross_item ?? null,
  };
}

function metaCausePriorList(profile: SubjectProfile): string {
  // Undeclared prior renders as null, matching getMetaCausePrior's runtime fallback.
  return profile.causeCategories
    .map((category) => `- ${category.id} → ${category.meta_cause_prior ?? 'null'}`)
    .join('\n');
}

function metaCauseContract(profile: SubjectProfile): string {
  return `跨科机制轴（冷启先验，不是硬映射）：
${metaCausePriorList(profile)}
实例级 meta_cause 必须在 ${MetaCause.options.join(' | ')} 中选择，或在没有足够证据时为 null。用输入里的行为与历史修正先验：hints_used > 0 且作答显示随提示改对时 self_corrected_on_hint=true；同题近期作答或同知识点近 14 天失败里同一错因再现时 recurred_cross_item=true；self_confidence 高却判错时 metacog_flag 取 overconfident、false_fluency、blind_spot 里最贴切的一个，把握低或在猜时取 poor_resolution。对应字段为 null 或没有记录时，布尔字段写 null，禁止猜测。
故意跳步、不验算等 violation 属动机/调节问题：写 metacog_flag="regulation_gap" 且 meta_cause=null，不得硬塞进六类能力机制。
六个字段必须都出现在 JSON；未知值写 null。`;
}

const META_CAUSE_JSON_FIELDS = {
  meta_cause: `"<${MetaCause.options.join('|')} 或 null>"`,
  meta_cause_secondary: `"<${MetaCause.options.join('|')} 或 null>"`,
  metacog_flag: `"<${MetacogFlag.options.join('|')} 或 null>"`,
  bloom_level: `"<${BloomLevel.options.join('|')} 或 null>"`,
  self_corrected_on_hint: 'true|false|null',
  recurred_cross_item: 'true|false|null',
} satisfies Record<keyof MetaCauseFieldsT, string>;

function metaCauseJsonFields(): string {
  return Object.entries(META_CAUSE_JSON_FIELDS)
    .map(([field, example]) => `"${field}": ${example}`)
    .join(', ');
}

function attributionEvidenceGuide(): string {
  return `字段含义：
- grading_evidence：有效判定里丢分或选错/漏选的评分项。units[].wrong_option_ids 是选错的选项 id，missed_option_ids 是漏选的选项 id，points_awarded / points_full 是得分与满分，reason_md 是判分理由，model_observations 是模型对非文本证据的未校验观察。null 表示这次没有结构化判分；units 为空表示判了但没有可摘的丢分项。
- behavior：self_confidence 是学习者自评把握（记录了才有，通常 1–5），duration_ms 是用时毫秒，hints_used 是用过的提示次数，final_hint_level 是最后看到的提示层级。null 表示没记录，禁止当成 0。
- failed_part_pitfalls：本题解法先验里、失败那一小问的易错点。mechanism_md 是错法，trigger_md 是什么情境会触发。这是题目的常见坑，不是这次已经证实的错因。空数组表示没有先验或对不上失败小问。
- recent_same_question：同一题最近几次作答（不含本次）的结果和错因。cause_category 为 null 只表示这次失败还没有错因记录（包括还没归因的复习），不能当成「确认没有这类错」或据此否定复发。
- knowledge_failure_counts_14d：这些知识点近 14 天的失败次数（含本次）。
- prerequisite_mastery：这些知识点的直接先修和掌握档（萌芽 / 成长 / 稳固 / 精熟）。band 为 null 表示还没有该先修自己的掌握读数，不是萌芽。先修档低时，错因要考虑先修缺口，不要只归到本题概念。`;
}

function attributionSharedRules(profile: SubjectProfile): string {
  return `科目上下文：${profile.displayName}。${profile.languageStyle}
归因 taxonomy 来自当前 SubjectProfile：
${causeTaxonomyList(profile)}
${metaCauseContract(profile)}
${attributionEvidenceGuide()}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
归因结果作为 judge event 写入 (action='judge', subject_kind='event', caused_by_event_id=<attempt event id>)；payload.cause 即此输出。`;
}

function buildAttributionPrompt(profile: SubjectProfile): string {
  return `你是错题归因助手。输入来自一次失败作答（prompt_md、reference_md、wrong_answer_md、knowledge_context，外加判分证据、作答行为、失败小问易错点、同题近期作答、近 14 天失败次数、直接先修掌握档）。先看 grading_evidence 里选错或漏选的选项、丢分评分项和理由，再对照 behavior、failed_part_pitfalls、recent_same_question、knowledge_failure_counts_14d 和 prerequisite_mastery。analysis_md 要点名具体选项 id 或评分项；对得上的易错点写出来；先修档低时说明是先修缺口还是本题概念。
${attributionSharedRules(profile)}
输出严格 JSON 格式（不带 markdown 代码块包裹）：
{"primary_category": "<${causeIdList(profile)} 之一>", "secondary_categories": [...], "analysis_md": "<点名选项或评分项 + 错答与参考答案差异 + 对得上的易错点 + 涉及的知识点>", "confidence": 0.0-1.0, ${metaCauseJsonFields()}}
低信心走 other（若 profile 有 other）或最接近的类别，并在 analysis_md 里说明不确定点。`;
}

function buildAttributionRerankPrompt(profile: SubjectProfile): string {
  return `你是错题归因助手。输入来自一次失败作答（prompt_md、reference_md、wrong_answer_md、knowledge_context、candidates，外加判分证据、作答行为、失败小问易错点、同题近期作答、近 14 天失败次数、直接先修掌握档）。先看 grading_evidence 里选错或漏选的选项、丢分评分项和理由，再对照 behavior、failed_part_pitfalls、recent_same_question、knowledge_failure_counts_14d 和 prerequisite_mastery。
${attributionSharedRules(profile)}
另外，输入里附带一个结构化候选集 candidates: [{ id, label, description, review_priority }] —— 这是 L1 召回阶段交给你的候选错因清单。primary_category **必须**从 candidates 的 id 里选；先在 analysis_md 里逐候选权衡（为什么选这个 / 为什么排除其它候选），再给结论。analysis_md 要点名具体选项 id 或评分项，并写上对得上的易错点。
输出严格 JSON 格式（不带 markdown 代码块包裹）：
{"primary_category": "<candidates 里某个 id>", "secondary_categories": [...], "analysis_md": "<逐候选权衡 + 点名选项或评分项 + 对得上的易错点 + 涉及的知识点>", "confidence": 0.0-1.0, ${metaCauseJsonFields()}}
低信心走 other（若 candidates 含 other）或最接近的候选，并在 analysis_md 里说明不确定点。`;
}

export const attributionTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'AttributionTask',
    description: '错题归因 + 知识点挂载（profile-scoped cause）',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 4 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    context: {
      view: 'none',
      reason:
        '错因归因装配当次作答、有效判分、作答行为、失败小问易错点、同题近期作答、近 14 天失败次数和直接先修掌握档。学习者记忆画像不在输入里。',
    },

    prompt: { kind: 'profile', build: buildAttributionPrompt },
  },
  outputSchema: AttributionOutputSchema,
  parseText(text, { subjectProfile }) {
    return parseAttributionOutput(text, subjectProfile);
  },
} satisfies TaskSpec<AttributionInput, AttributionOutput>;

export const attributionRerankTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'AttributionRerankTask',
    description:
      '错题归因（retrieve→rerank stage 2）：从候选 cause 列表重排 + 选 primary + 逐候选理由',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 4 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    context: {
      view: 'none',
      reason:
        '错因归因装配当次作答、有效判分、作答行为、失败小问易错点、同题近期作答、近 14 天失败次数和直接先修掌握档。学习者记忆画像不在输入里。',
    },

    prompt: { kind: 'profile', build: buildAttributionRerankPrompt },
  },
  outputSchema: AttributionOutputSchema,
  parseText(text, { subjectProfile }) {
    return parseAttributionOutput(text, subjectProfile);
  },
} satisfies TaskSpec<AttributionRerankInput, AttributionOutput>;
