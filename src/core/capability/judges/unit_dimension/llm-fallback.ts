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
  // YUK-64: runTaskFn must be injected by server-side caller. core/ cannot
  // import @/server (CLAUDE.md layering). JudgeInvoker + tests all already
  // inject runTaskFn; this guard catches future regressions at runtime instead
  // of silently bundling server code into the client.
  if (!params.runTaskFn) {
    throw new Error(
      'unit_dimension/llm-fallback: runTaskFn must be injected by caller (server-side). See YUK-64.',
    );
  }
  const runTask = params.runTaskFn;
  const prompt = PROMPT_TEMPLATE.replace('{{student_answer}}', params.student_answer)
    .replace('{{reference_value}}', String(params.reference.value))
    .replace('{{reference_unit}}', params.reference.unit)
    .replace(
      '{{context}}',
      params.question_context_md ? `题面: ${params.question_context_md}` : '',
    );

  const result = await runTask('UnitDimensionFallback', { text: prompt }, params.runTaskCtx ?? {});
  const parsed = LlmFallbackOutput.parse(JSON.parse(extractJsonObject(result.text)));
  return parsed;
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('unit_dimension fallback output did not contain a JSON object');
  }
  return text.slice(start, end + 1);
}
