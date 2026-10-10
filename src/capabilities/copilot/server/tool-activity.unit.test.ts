import { describe, expect, it } from 'vitest';

import { sanitizeToolUseForSse } from '@/capabilities/copilot/server/tool-activity';

describe('tool-use SSE sanitization — YUK-457 P1', () => {
  it('drops native Task tool_use frames that would leak subagent prompts', () => {
    const leaked = sanitizeToolUseForSse({
      toolName: 'Task',
      toolUseId: 'toolu-task-42',
      input: {
        subagent_type: 'copilot-researcher',
        description: '核对近七日必要条件/充分条件错题',
        prompt:
          '比较错题 att_logic_17、复习 review_logic_22 与 probe_logic_09；区分必要条件、充分条件及逆命题。',
        instructions: 'Do not expose this transcript to the user.',
      },
    });

    expect(leaked).toBeNull();
  });
});
