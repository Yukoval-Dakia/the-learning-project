import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type StructuredSubmitUnitPlan, type TaskSpec } from '@/ai/task-spec';
import { AttemptDescription, BacktraceDecisions } from '@/core/schema/backtrace';
import { parseTaskOutput } from '@/kernel/parse-task-output';

// Whole-object submits on this lane exceed ~850 chars and pick up an emitted
// trailing brace (attempt6 wires 9-11: complete JSON + one extra '}'); the
// per-unit contract keeps every submit far below that threshold.
const InsightFacet = z.union([
  z.object({ method: AttemptDescription.shape.method }).strict(),
  z.object({ needed_method: AttemptDescription.shape.needed_method }).strict(),
  z.object({ mechanism: AttemptDescription.shape.mechanism }).strict(),
  z.object({ no_description_reason: AttemptDescription.shape.no_description_reason }).strict(),
]);

function insightFacetKey(submitted: unknown): string | undefined {
  if (!submitted || typeof submitted !== 'object') return undefined;
  const keys = Object.keys(submitted);
  return keys.length === 1 && InsightFacet.safeParse(submitted).success ? keys[0] : undefined;
}

export const attemptInsightTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'AttemptInsightTask',
    description: '描述学习者本次具体错法与本人解法',
    budget: { ...DEFAULT_TASK_BUDGET, timeout: 600_000, maxIterations: 3 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['mcp__structured_output__submit'],
    context: { view: 'none', reason: '只读冻结作答证据，不读取画像。' },
    structuredOutputMode: 'tool',
    structuredSubmitSchema: () => InsightFacet,
    structuredSubmitUnits: (): StructuredSubmitUnitPlan => ({
      expectedUnitIds: ['method', 'needed_method', 'mechanism', 'no_description_reason'],
      unitOf: (submitted) => ({ id: insightFacetKey(submitted), unit: submitted }),
      validateUnit: (submitted) =>
        InsightFacet.safeParse(submitted).success
          ? []
          : ['unit: submit exactly one declared description field; null when absent'],
      assemble: (units) => Object.assign({}, ...units),
    }),
    structuredOutputSchema: AttemptDescription,
    prompt: {
      kind: 'inline',
      text: '只据reasoning_trace；没过程则null。本人明写标evidence，evidence_quotes/steps.quote逐字摘原文；没明说的算法仅标inferred，不冒充本人方法。参考解只放needed_method。具体错法点名步骤和条件，用户错因保留原话；无错则mechanism=null。逐字段submit，无值字段交null。',
    },
  },
  outputSchema: AttemptDescription,
  parseText: (text) => parseTaskOutput(text, 'AttemptInsightTask', AttemptDescription),
} satisfies TaskSpec<unknown, unknown>;

const Match = BacktraceDecisions.shape.matches.element;

function candidateIds(input: unknown): string[] {
  if (
    !input ||
    typeof input !== 'object' ||
    !('candidates' in input) ||
    !Array.isArray(input.candidates)
  )
    return [];
  return input.candidates.map((x) => x.attempt_event_id);
}

// Longest observed completed single-part run: 158.5s, including one correction.
// tlp-docs/audit/yuk1941-solve-tokens/prior-diagnosis.md; reserve 60s for closure.
export const backtraceJudgeTimeoutMs = (input: unknown) =>
  candidateIds(input).length * 160_000 + 60_000;

export const backtraceJudgeTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'BacktraceJudgeTask',
    description: '判断历史作答的具体相似错法与相似解法',
    budget: { ...DEFAULT_TASK_BUDGET, timeout: 16 * 160_000 + 60_000, maxIterations: 3 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['mcp__structured_output__submit'],
    context: { view: 'none', reason: '只比较提供的本人历史作答，不判分。' },
    structuredOutputMode: 'tool',
    structuredSubmitSchema: () => Match,
    structuredSubmitUnits: (input: unknown): StructuredSubmitUnitPlan | undefined => {
      const ids = candidateIds(input);
      if (
        !ids.length ||
        ids.some((id) => typeof id !== 'string') ||
        new Set(ids).size !== ids.length
      )
        return undefined;
      return {
        expectedUnitIds: ids,
        unitOf: (submitted) => ({
          id: Match.safeParse(submitted).data?.attempt_event_id,
          unit: submitted,
        }),
        validateUnit: (submitted) =>
          Match.safeParse(submitted).success ? [] : ['match: must match the declared schema'],
        assemble: (units) => ({ matches: [...units] }),
      };
    },
    structuredOutputSchema: BacktraceDecisions,
    prompt: {
      kind: 'inline',
      text: 'anchor本次，candidate过去。机制同即same_mechanism；same_method仅原文方法；候选成功用本次needed_method即needs_this_method。肯定关系必附evidence（now/prior逐字摘对应字段原文），缺即not_similar；失败非成功解法，inferred不作依据。机制或方法结构同即specific，数字题型可不同；审题单位只能broad。why不加算法；shared_step仅已有键。',
    },
  },
  outputSchema: BacktraceDecisions,
  parseText: (text) => parseTaskOutput(text, 'BacktraceJudgeTask', BacktraceDecisions),
} satisfies TaskSpec<unknown, unknown>;
