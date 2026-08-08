import {
  type VariantProposalResult,
  createFailureLearning,
} from '@/capabilities/practice/server/failure-learning';
import { makePracticeTaskRunFn } from '@/capabilities/practice/server/task-runtime';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

const ProposeVariantInputSchema = z.object({
  attempt_event_id: z.string().min(1),
  count: z.literal(1).optional(),
});

const ProposeVariantOutputSchema = z.object({
  status: z.enum([
    'generated',
    'skipped:attempt_not_found',
    'skipped:not_failure_attempt',
    'skipped:attempt_not_active',
    'skipped:no_judge_yet',
    'skipped:question_not_found',
    'skipped:max_depth',
    'skipped:variant_chain_terminus',
    'skipped:cause_not_targetable',
    'skipped:already_has_variant',
    'skipped:variants_max_reached',
    'failed',
  ]),
  proposal_ids: z.array(z.string()),
  mistake_variant_ids: z.array(z.string()),
  variant_question_ids: z.array(z.string()),
  reasoning_summary: z.string().optional(),
});

type ProposeVariantInput = z.infer<typeof ProposeVariantInputSchema>;
type ProposeVariantOutput = z.infer<typeof ProposeVariantOutputSchema>;

export function mapVariantProposalToToolOutput(
  result: VariantProposalResult,
): ProposeVariantOutput {
  if (result.status === 'failed:invalid_model_output') {
    return {
      status: 'failed',
      proposal_ids: [],
      mistake_variant_ids: [],
      variant_question_ids: [],
      reasoning_summary: result.reason,
    };
  }
  if (result.status !== 'proposed') {
    return {
      status:
        result.status === 'skipped:not_a_failure_attempt'
          ? 'skipped:not_failure_attempt'
          : result.status,
      proposal_ids: [],
      mistake_variant_ids: [],
      variant_question_ids: [],
    };
  }
  return {
    status: 'generated',
    proposal_ids: result.proposal_id ? [result.proposal_id] : [],
    mistake_variant_ids: result.mistake_variant_id ? [result.mistake_variant_id] : [],
    variant_question_ids: [],
    reasoning_summary: result.proposal_id ? `proposal ${result.proposal_id}` : undefined,
  };
}

async function proposeVariantExecute(
  ctx: ToolContext,
  raw: ProposeVariantInput,
): Promise<ProposeVariantOutput> {
  const input = ProposeVariantInputSchema.parse(raw);
  try {
    return mapVariantProposalToToolOutput(
      await createFailureLearning({
        db: ctx.db,
        runTaskFn: makePracticeTaskRunFn(ctx.db, {
          signal: ctx.signal,
          parentTaskRunId: ctx.taskRunId,
          ...(ctx.providerSessionDeadlineAt !== undefined
            ? { providerSessionDeadlineAt: ctx.providerSessionDeadlineAt }
            : {}),
        }),
      }).proposeVariant({ attemptEventId: input.attempt_event_id }),
    );
  } catch (err) {
    return {
      status: 'failed',
      proposal_ids: [],
      mistake_variant_ids: [],
      variant_question_ids: [],
      reasoning_summary: err instanceof Error ? err.message : String(err),
    };
  }
}

export const proposeVariantTool: DomainTool<ProposeVariantInput, ProposeVariantOutput> = {
  name: 'propose_variant',
  description:
    'Generate one targeted variant-question proposal for a failure attempt through the Failure Learning guards: active failure, cause required, targetable cause, depth cap, and variant caps.',
  effect: 'propose',
  inputSchema: ProposeVariantInputSchema,
  outputSchema: ProposeVariantOutputSchema,
  costClass: 'cheap_llm',
  execute: proposeVariantExecute,
  summarize(input, output) {
    return `variant ${input.attempt_event_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
