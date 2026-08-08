import { describe, expect, it } from 'vitest';
import { attributeMistakeTool } from './attribute-mistake';
import { mapVariantProposalToToolOutput, proposeVariantTool } from './propose-variant';

describe('practice-owned Failure Learning DomainTools', () => {
  it('preserves the attribute_mistake public contract', () => {
    expect(attributeMistakeTool).toMatchObject({
      name: 'attribute_mistake',
      effect: 'write',
      costClass: 'cheap_llm',
      mirrorEvent: 'when_causal',
    });
    expect('shape' in attributeMistakeTool.inputSchema).toBe(true);
    expect(() =>
      attributeMistakeTool.inputSchema.parse({ attempt_event_id: 'attempt-1' }),
    ).not.toThrow();
  });

  it('preserves the propose_variant public contract and success vocabulary', () => {
    expect(proposeVariantTool).toMatchObject({
      name: 'propose_variant',
      effect: 'propose',
      costClass: 'cheap_llm',
      mirrorEvent: 'when_causal',
    });
    expect('shape' in proposeVariantTool.inputSchema).toBe(true);
    expect(
      mapVariantProposalToToolOutput({
        status: 'proposed',
        proposal_id: 'proposal-1',
        mistake_variant_id: 'variant-1',
      }),
    ).toEqual({
      status: 'generated',
      proposal_ids: ['proposal-1'],
      mistake_variant_ids: ['variant-1'],
      variant_question_ids: [],
      reasoning_summary: 'proposal proposal-1',
    });
  });

  it('folds owner-only status spellings into the legacy tool vocabulary', () => {
    expect(mapVariantProposalToToolOutput({ status: 'skipped:not_a_failure_attempt' })).toEqual({
      status: 'skipped:not_failure_attempt',
      proposal_ids: [],
      mistake_variant_ids: [],
      variant_question_ids: [],
    });
    expect(
      mapVariantProposalToToolOutput({
        status: 'failed:invalid_model_output',
        reason: 'invalid variant JSON',
      }),
    ).toEqual({
      status: 'failed',
      proposal_ids: [],
      mistake_variant_ids: [],
      variant_question_ids: [],
      reasoning_summary: 'invalid variant JSON',
    });
  });
});
