import { describe, expect, it } from 'vitest';

import { createCopilotProposalFlowGate } from './proposal-flow-gate';

describe('createCopilotProposalFlowGate', () => {
  it('requires a successful read re-plan after a typed not_found proposal result', () => {
    const gate = createCopilotProposalFlowGate();

    gate.observe({
      name: 'propose_learning_item_archive',
      effect: 'propose',
      input: { learning_item_id: 'missing_item' },
      output: { status: 'skipped:not_found' },
      error_reason: null,
      executed: true,
    });

    expect(gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' })).toBe(
      'proposal_requires_replan_after_typed_failure',
    );
    expect(gate.beforeExecute({ name: 'query_questions', effect: 'read' })).toBeUndefined();

    gate.observe({
      name: 'query_questions',
      effect: 'read',
      input: { query: 'candidate' },
      output: { rows: [] },
      error_reason: null,
      executed: true,
    });

    expect(
      gate.beforeExecute({ name: 'propose_knowledge_mutation', effect: 'propose' }),
    ).toBeUndefined();
  });
});
