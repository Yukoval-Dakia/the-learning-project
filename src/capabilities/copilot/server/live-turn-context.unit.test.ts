import { describe, expect, it } from 'vitest';
import type { CopilotRunInput } from './copilot-run-input';
import { compileCopilotModelInput } from './live-turn-context';

function input(overrides: Partial<CopilotRunInput> = {}): CopilotRunInput {
  return {
    surface: 'copilot',
    triggered_by: 'chat',
    user_message: '请比较定义域边界。',
    proposal_feedback: [],
    conversation_history: [],
    validator_context_history: [],
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
  it('keeps the bounded structured history envelope for cold and durable execution', () => {
    const modelInput = compileCopilotModelInput(
      input({
        learner_state_header: '当前目标：含参方程',
        conversation_history: [
          { role: 'context', text: '当前目标：含参方程' },
          { role: 'user', text: '先前问题' },
        ],
      }),
      'cold',
    );
    const parsed = JSON.parse(modelInput);
    expect(parsed).toMatchObject({
      user_message: '请比较定义域边界。',
      conversation_history: [
        { role: 'context', text: '当前目标：含参方程' },
        { role: 'user', text: '先前问题' },
      ],
    });
    expect(parsed).not.toHaveProperty('learner_state_header');
    expect(modelInput.match(/当前目标：含参方程/g)).toHaveLength(1);
  });

  it('sends exact plaintext on a plain resume without re-sending history', () => {
    const modelInput = compileCopilotModelInput(
      input({
        conversation_history: [{ role: 'ai', text: '很长的历史回答', event_id: 'reply_1' }],
        validator_context_history: [
          { role: 'ai', text: 'validator 需要的历史回答', event_id: 'reply_1' },
        ],
      }),
      'resume',
    );
    expect(modelInput).toBe('请比较定义域边界。');
    expect(modelInput).not.toContain('很长的历史回答');
    expect(modelInput).not.toContain('validator 需要的历史回答');
  });

  it('adds compact deterministic ambient context before the plaintext resume message', () => {
    const modelInput = compileCopilotModelInput(
      input({
        ambient_context: {
          route: '/knowledge/graph',
          focused_entity: { kind: 'knowledge', id: 'knowledge_boundary_42' },
        },
      }),
      'resume',
    );
    expect(modelInput).toContain(
      '<turn_context>{"v":1,"ambient":{"route":"/knowledge/graph","focused_entity":{"kind":"knowledge","id":"knowledge_boundary_42"}}}</turn_context>',
    );
    expect(modelInput.endsWith('\n请比较定义域边界。')).toBe(true);
  });

  it('carries the documented bound correction_contract without conversation history', () => {
    const modelInput = compileCopilotModelInput(
      input({
        conversation_history: [
          { role: 'ai', text: '不得重发的旧回答正文', event_id: 'copilot_reply_d04' },
        ],
        correction_contract: {
          target_prior_turn_id: 'copilot_reply_d04',
          available_prior_turn_ids: ['copilot_reply_d04'],
          prior_turn_summaries: { copilot_reply_d04: '电池 D04' },
          required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
        },
      }),
      'resume',
    );
    expect(modelInput).toContain('"correction_contract"');
    expect(modelInput).toContain('"prior_turn_summaries":{"copilot_reply_d04":"电池 D04"}');
    expect(modelInput).toContain('copilot_reply_d04');
    expect(modelInput).not.toContain('不得重发的旧回答正文');
    expect(modelInput).not.toContain('conversation_history');
  });

  it('carries current learner and proposal facts that are outside the SDK transcript', () => {
    const modelInput = compileCopilotModelInput(
      input({
        learner_state_header: '当前目标：边界条件',
        proposal_feedback: [
          {
            kind: 'knowledge_edge',
            relation: 'prerequisite',
            acceptance_rate: 0.25,
            top_dismiss_reasons: ['范围过宽'],
            top_rubric_gates: ['先核对定义域'],
          },
        ],
      }),
      'resume',
    );
    expect(modelInput).toContain('当前目标：边界条件');
    expect(modelInput).toContain('范围过宽');
    expect(modelInput.endsWith('\n请比较定义域边界。')).toBe(true);
  });
});
