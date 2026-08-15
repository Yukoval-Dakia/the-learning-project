import { causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';
import { z } from 'zod';

export interface VariantGenInput {
  original_question: {
    id: string;
    kind: string;
    prompt_md: string;
    reference_md: string | null;
    knowledge_ids: string[];
  };
  attempt: { wrong_answer_md: string };
  cause: { primary_category: string; analysis_md: string };
  depth: number;
}

export const VariantOutputSchema = z.object({
  prompt_md: z.string().min(1).max(2000),
  reference_md: z.string().min(1).max(2000),
  difficulty: z.number().int().min(1).max(5),
  reasoning: z.string().min(1).max(500),
});

export type VariantGenOutput = z.infer<typeof VariantOutputSchema>;

export function parseVariantOutput(text: string): VariantGenOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseVariantOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`parseVariantOutput: JSON.parse failed: ${(error as Error).message}`);
  }
  return VariantOutputSchema.parse(json);
}

const VARIANT_CAUSE_STRATEGIES: Record<string, string> = {
  concept: '同概念不同语境 / 反向考查（验证概念边界）',
  knowledge_gap: '补充该知识点的典型变体',
  calculation: '改数据 + 留同样陷阱（验证计算稳定性）',
  reading: '改提问方式 + 加干扰信息',
  memory: '不同表述测同一记忆点',
  expression: '同题重写答案要求（重点检查表达）',
  method: '提示备选方法 + 同类型题',
  unit_error: '改变单位、量纲或换算条件，检查单位一致性',
};

function variantCauseStrategyList(profile: SubjectProfile): string {
  return profile.causeCategories
    .map((category) => {
      const strategy =
        VARIANT_CAUSE_STRATEGIES[category.id] ??
        `围绕「${category.label}」设计同知识点、同能力目标的针对性变式`;
      return `- ${category.id}（${category.label}）：${strategy}`;
    })
    .join('\n');
}

function buildVariantGenPrompt(profile: SubjectProfile): string {
  return `你是错题变式题作者。输入 { original_question: { id, prompt_md, reference_md, knowledge_ids, kind }, attempt: { wrong_answer_md }, cause: { primary_category, analysis_md }, depth }（depth 是原题代数：0=原题，1=一代变式；输入 depth≥2 时不会调用本任务）。
科目上下文：${profile.displayName}。${profile.languageStyle}
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
按 cause 类型出 1 道针对性变式（不要凑数，1 道即可）。策略参考：
${variantCauseStrategyList(profile)}
严格 JSON 输出（不带 markdown 包裹）：
{"prompt_md":"...","reference_md":"...","difficulty":1-5,"reasoning":"说明这是怎么针对 cause 设计的"}
要点：
- prompt_md 与 original_question 同 kind / 同 knowledge_ids 范围
- reference_md 必填且正确（你能解出来）
- ${profile.promptFragments.variantExamplePolicy}
- ${profile.grounding.uncertaintyPolicy}
- 禁止：直接照抄 original prompt 的句子；套话；复杂多义题面`;
}

export const variantGenTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'VariantGenTask',
    description:
      'Phase 2 — 给一道错题 + cause 生成 1 条 variant_question proposal。spec §3.4.1 cause-targeted；接受后再物化 question/draft_status',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildVariantGenPrompt },
  },
  outputSchema: VariantOutputSchema,
  parseText(text) {
    return parseVariantOutput(text);
  },
} satisfies TaskSpec<VariantGenInput, VariantGenOutput>;
