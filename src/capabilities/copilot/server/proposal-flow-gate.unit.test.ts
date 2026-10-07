import { describe, expect, it } from 'vitest';

import { createCopilotProposalFlowGate } from './proposal-flow-gate';

describe('createCopilotProposalFlowGate', () => {
  it.each([
    'skipped:not_found',
    'skipped:unknown_node',
    'skipped:invalid_state',
    'skipped:invalid_op',
    'skipped:not_active',
    'skipped:no_structure',
    'skipped:gate_rejected',
    'failed',
  ])('blocks mutations after a typed proposal result with status %s', (status) => {
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
  });

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

  it('does not lock on skipped:invalid_payload (in-execute arg validation)', () => {
    const gate = createCopilotProposalFlowGate();

    // skipped:invalid_payload is input validation inside an executed tool —
    // the tree is untouched; the model should repair args and retry directly.
    gate.observe({
      name: 'propose_knowledge_mutation',
      effect: 'propose',
      input: { mutation: 'propose_new', payload: { name: 'English', parent_id: null } },
      output: {
        status: 'skipped:invalid_payload',
        reason: 'root proposal (parent_id=null) requires a selectable payload.domain',
      },
      error_reason: null,
      executed: true,
    });

    expect(
      gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' }),
    ).toBeUndefined();
  });

  it('does not lock on calls that never executed (gate/parse/soft-stop rejections)', () => {
    const gate = createCopilotProposalFlowGate();

    // executed:false covers pre-execution rejections — outer input parse
    // failure, a beforeExecute gate block, a budget soft-stop. The tree is
    // untouched, so no re-plan is required.
    gate.observe({
      name: 'propose_knowledge_mutation',
      effect: 'propose',
      input: { mutation: 'propose_new', payload: { parent_id: null } },
      output: { error: 'proposal_requires_replan_after_typed_failure' },
      error_reason: 'proposal_requires_replan_after_typed_failure',
      executed: false,
    });

    expect(
      gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' }),
    ).toBeUndefined();
  });

  it('does not lock on a Zod issues failure thrown inside an executed propose tool', () => {
    const gate = createCopilotProposalFlowGate();

    // A tool's own in-execute schema parse throws a ZodError whose message is
    // the serialized issues array — a bad-args failure, not a mutation that
    // may have left the tree in an unexpected state.
    gate.observe({
      name: 'propose_knowledge_mutation',
      effect: 'propose',
      input: { mutation: 'propose_new', payload: { name: 'English' } },
      output: {
        error:
          '[{"code":"invalid_type","expected":"string","path":["payload","parent_id"],"message":"Invalid input"}]',
      },
      error_reason:
        '[{"code":"invalid_type","expected":"string","path":["payload","parent_id"],"message":"Invalid input"}]',
      executed: true,
    });

    expect(
      gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' }),
    ).toBeUndefined();
  });

  it('still locks on an executed proposal that throws a non-validation error', () => {
    const gate = createCopilotProposalFlowGate();

    gate.observe({
      name: 'propose_knowledge_mutation',
      effect: 'propose',
      input: { mutation: 'propose_new', payload: { name: 'X' } },
      output: { error: 'relation "knowledge" does not exist' },
      error_reason: 'relation "knowledge" does not exist',
      executed: true,
    });

    expect(gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' })).toBe(
      'proposal_requires_replan_after_typed_failure',
    );
  });

  it('does not treat a presentation control as replanning after a failed proposal', () => {
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
      name: 'present_primary_view',
      effect: 'control',
      input: {
        source: { kind: 'query_questions', id: 'toolu_root_query' },
      },
      output: {
        status: 'accepted',
        primary_view: {
          kind: 'tool_result',
          ref: { kind: 'query_questions', id: 'toolu_root_query' },
        },
      },
      error_reason: null,
      executed: true,
    });

    expect(gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' })).toBe(
      'proposal_requires_replan_after_typed_failure',
    );
  });
});
