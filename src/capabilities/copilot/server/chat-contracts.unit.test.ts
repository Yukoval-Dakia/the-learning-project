import { describe, expect, it } from 'vitest';

import { CopilotChatRequest } from './chat-contracts';

describe('CopilotChatRequest wire enum (C3 / YUK-284)', () => {
  it('accepts skill_context.skill = teaching | solve | quiz (向后兼容)', () => {
    for (const skill of ['teaching', 'solve', 'quiz'] as const) {
      const parsed = CopilotChatRequest.parse({
        user_message: 'x',
        triggered_by: 'chat',
        skill_context: { skill, ref: { kind: 'knowledge', id: 'k1' } },
      });
      expect(parsed.skill_context?.skill).toBe(skill);
    }
  });

  it('rejects an unknown skill_context.skill value', () => {
    expect(() =>
      CopilotChatRequest.parse({
        user_message: 'x',
        triggered_by: 'chat',
        skill_context: { skill: 'bogus', ref: { kind: 'knowledge', id: 'k1' } },
      }),
    ).toThrow();
  });
});

describe('CopilotChatRequest', () => {
  it('rejects a correction target on the teaching behavior-pack path', () => {
    const result = CopilotChatRequest.safeParse({
      user_message: '请改正上一轮教学回答',
      triggered_by: 'chat',
      correction_target_turn_id: 'copilot_reply_teaching_prior',
      skill_context: {
        skill: 'teaching',
        ref: { kind: 'learning_item', id: 'li_teaching' },
      },
    });

    expect(result.success).toBe(false);
  });
});
