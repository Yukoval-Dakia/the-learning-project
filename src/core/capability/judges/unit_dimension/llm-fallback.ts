import { LlmFallbackOutput, type LlmFallbackOutputT } from './types';

export type RunTaskFn = (
  kind: string,
  input: { text: string },
  ctx: unknown,
) => Promise<{ text: string }>;

export interface LlmFallbackParams {
  student_answer: string;
  reference: { value: number; unit: string };
  question_context_md?: string;
  runTaskFn?: RunTaskFn;
  runTaskCtx?: unknown;
}

const PROMPT_TEMPLATE = `你是物理单位与量纲分析助手。给定学生答案 + 参考答案，输出 JSON：
\`\`\`
{
  "student_value_si": number | null,
  "student_unit_si": string | null,
  "equivalent_to_reference": boolean,
  "dimension_mismatch_reason": string | undefined,
  "parser_confidence": number (0-1)
}
\`\`\`
学生答案: "{{student_answer}}"
参考: {{reference_value}} {{reference_unit}}
{{context}}
仅返回 JSON，无其它文字。`;

export async function runLlmFallback(params: LlmFallbackParams): Promise<LlmFallbackOutputT> {
  const runTask = params.runTaskFn ?? defaultRunTaskFn;
  const prompt = PROMPT_TEMPLATE.replace('{{student_answer}}', params.student_answer)
    .replace('{{reference_value}}', String(params.reference.value))
    .replace('{{reference_unit}}', params.reference.unit)
    .replace(
      '{{context}}',
      params.question_context_md ? `题面: ${params.question_context_md}` : '',
    );

  const result = await runTask('UnitDimensionFallback', { text: prompt }, params.runTaskCtx ?? {});
  const parsed = LlmFallbackOutput.parse(JSON.parse(result.text));
  return parsed;
}

async function defaultRunTaskFn(
  kind: string,
  input: { text: string },
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}
