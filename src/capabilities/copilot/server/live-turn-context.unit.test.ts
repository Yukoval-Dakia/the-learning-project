import { describe, expect, it } from 'vitest';
import type { CopilotRunInput } from './copilot-run-input';
import { compileCopilotModelInput, compileCopilotSessionContext } from './live-turn-context';

function input(overrides: Partial<CopilotRunInput> = {}): CopilotRunInput {
  return {
    surface: 'copilot',
    triggered_by: 'chat',
    user_message: '请比较定义域边界。',
    proposal_feedback: [],
    conversation_history: [],
    learner_state_header: '',
    correction_contract: {
      available_prior_turn_ids: [],
      prior_turn_summaries: {},
      required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
    },
    ...overrides,
  };
}

describe('compileCopilotModelInput', () => {
  it('never serializes restricted correction positions or target metadata into cold, resume or compaction', () => {
    const current = input({
      correction_contract: {
        target_prior_turn_id: 'restricted_reply_hidden',
        restricted_target: true,
        prior_turn_order: ['ordinary_reply_1', 'restricted_reply_hidden'],
        restricted_prior_turn_ids: ['restricted_reply_hidden'],
        positions_unavailable: true,
        available_prior_turn_ids: ['ordinary_reply_1'],
        prior_turn_summaries: { ordinary_reply_1: '允许使用的定义域证据' },
        required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
      },
    });
    for (const text of [
      compileCopilotModelInput(current, 'cold'),
      compileCopilotModelInput(current, 'resume'),
      compileCopilotSessionContext(current),
    ]) {
      expect(text).not.toContain('restricted_reply_hidden');
      expect(text).not.toContain('prior_turn_order');
      expect(text).not.toContain('positions_unavailable');
    }
  });
});
