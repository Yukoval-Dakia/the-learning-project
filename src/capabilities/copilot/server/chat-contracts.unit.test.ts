import { describe, expect, it } from 'vitest';

import { CopilotChatRequest } from './chat-contracts';

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
