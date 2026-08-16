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
  getDefaultMetaCause,
  validateCauseAgainstProfile,
} from '@/core/schema/business';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';

export interface AttributionInput {
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
    meta_cause:
      parsed.meta_cause === undefined
        ? (getDefaultMetaCause(parsed.primary_category) ?? null)
        : parsed.meta_cause,
    meta_cause_secondary: parsed.meta_cause_secondary ?? null,
    metacog_flag: parsed.metacog_flag ?? null,
    bloom_level: parsed.bloom_level ?? null,
    self_corrected_on_hint: parsed.self_corrected_on_hint ?? null,
    recurred_cross_item: parsed.recurred_cross_item ?? null,
  };
}

function metaCausePriorList(profile: SubjectProfile): string {
  return profile.causeCategories
    .map((category) => `- ${category.id} → ${getDefaultMetaCause(category.id) ?? 'null'}`)
    .join('\n');
}

function metaCauseContract(profile: SubjectProfile): string {
  return `跨科机制轴（冷启先验，不是硬映射）：
${metaCausePriorList(profile)}
实例级 meta_cause 必须在 ${MetaCause.options.join(' | ')} 中选择，或在没有足够证据时为 null。优先按三类行为证据修正先验：给提示是否立即自纠（self_corrected_on_hint）、同一模式是否跨情境复现（recurred_cross_item）、信心与表现是否脱节（metacog_flag）。输入未提供某项行为证据时，对应布尔字段写 null，禁止猜测。
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

function buildAttributionPrompt(profile: SubjectProfile): string {
  return `你是错题归因助手。输入字段 { prompt_md, reference_md, wrong_answer_md, knowledge_context }（来自一个 attempt event outcome='failure'）—— 即用户做错的一道题，含 wrong_answer_md（用户错答）、参考答案 reference_md、挂的 knowledge_context，分析错因。
科目上下文：${profile.displayName}。${profile.languageStyle}
归因 taxonomy 来自当前 SubjectProfile：
${causeTaxonomyList(profile)}
${metaCauseContract(profile)}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
归因结果作为 judge event 写入 (action='judge', subject_kind='event', caused_by_event_id=<attempt event id>)；payload.cause 即此输出。
输出严格 JSON 格式（不带 markdown 代码块包裹）：
{"primary_category": "<${causeIdList(profile)} 之一>", "secondary_categories": [...], "analysis_md": "<分析过程，含错答与参考答案差异 + 涉及的知识点 / 概念>", "confidence": 0.0-1.0, ${metaCauseJsonFields()}}
低信心走 other（若 profile 有 other）或最接近的类别，并在 analysis_md 里说明不确定点。`;
}

function buildAttributionRerankPrompt(profile: SubjectProfile): string {
  return `你是错题归因助手。输入字段 { prompt_md, reference_md, wrong_answer_md, knowledge_context, candidates }（来自一个 attempt event outcome='failure'）—— 即用户做错的一道题，含 wrong_answer_md（用户错答）、参考答案 reference_md、挂的 knowledge_context，分析错因。
科目上下文：${profile.displayName}。${profile.languageStyle}
归因 taxonomy 来自当前 SubjectProfile：
${causeTaxonomyList(profile)}
${metaCauseContract(profile)}
另外，输入里附带一个结构化候选集 candidates: [{ id, label, description, review_priority }] —— 这是 L1 召回阶段交给你的候选错因清单。primary_category **必须**从 candidates 的 id 里选；先在 analysis_md 里逐候选权衡（为什么选这个 / 为什么排除其它候选），再给结论。
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
归因结果作为 judge event 写入 (action='judge', subject_kind='event', caused_by_event_id=<attempt event id>)；payload.cause 即此输出。
输出严格 JSON 格式（不带 markdown 代码块包裹）：
{"primary_category": "<candidates 里某个 id>", "secondary_categories": [...], "analysis_md": "<逐候选权衡 + 选定理由，含错答与参考答案差异 + 涉及的知识点 / 概念>", "confidence": 0.0-1.0, ${metaCauseJsonFields()}}
低信心走 other（若 candidates 含 other）或最接近的候选，并在 analysis_md 里说明不确定点。`;
}

export const attributionTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'AttributionTask',
    description: '错题归因 + 知识点挂载（profile-scoped cause）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 4 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
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
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 4 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildAttributionRerankPrompt },
  },
  outputSchema: AttributionOutputSchema,
  parseText(text, { subjectProfile }) {
    return parseAttributionOutput(text, subjectProfile);
  },
} satisfies TaskSpec<AttributionRerankInput, AttributionOutput>;
