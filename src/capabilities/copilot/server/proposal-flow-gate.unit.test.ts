import { describe, expect, it } from 'vitest';

import { createCopilotProposalFlowGate } from './proposal-flow-gate';

describe('createCopilotProposalFlowGate', () => {
  it.each(['skipped:not_found', 'skipped:unknown_node', 'skipped:invalid_payload', 'failed'])(
    'blocks mutations after a typed proposal result with status %s',
    (status) => {
      const gate = createCopilotProposalFlowGate();

      gate.observe({
        name: 'author_question',
        effect: 'propose',
        input: { target_id: 'candidate_b' },
        output: { status },
        error_reason: null,
        executed: true,
      });

      expect(gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' })).toBe(
        'proposal_requires_replan_after_typed_failure',
      );
      expect(gate.beforeExecute({ name: 'attribute_mistake', effect: 'write' })).toBe(
        'proposal_requires_replan_after_typed_failure',
      );
    },
  );

  it('blocks mutations after a proposal schema error', () => {
    const gate = createCopilotProposalFlowGate();

    gate.observe({
      name: 'author_question',
      effect: 'propose',
      input: { target_id: 'candidate_b' },
      output: { error: 'output_schema_invalid: status' },
      error_reason: 'output_schema_invalid: status',
      executed: true,
    });

    expect(gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' })).toBe(
      'proposal_requires_replan_after_typed_failure',
    );
  });

  it('keeps mutations blocked after a failed read and unlocks after a successful read', () => {
    const gate = createCopilotProposalFlowGate();
    gate.observe({
      name: 'author_question',
      effect: 'propose',
      input: { target_id: 'candidate_b' },
      output: { status: 'failed' },
      error_reason: null,
      executed: true,
    });

    gate.observe({
      name: 'query_questions',
      effect: 'read',
      input: { query: 'candidate' },
      output: { error: 'reader unavailable' },
      error_reason: 'reader unavailable',
      executed: true,
    });

    expect(gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' })).toBe(
      'proposal_requires_replan_after_typed_failure',
    );

    gate.observe({
      name: 'query_questions',
      effect: 'read',
      input: { query: 'candidate' },
      output: { rows: [{ id: 'candidate_b', prompt_md: 'A long candidate question.' }] },
      error_reason: null,
      executed: true,
    });

    expect(
      gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' }),
    ).toBeUndefined();
  });
});
