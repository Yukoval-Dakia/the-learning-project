import { describe, expect, it } from 'vitest';

import {
  sanitizeToolResultForSse,
  sanitizeToolUseForSse,
} from '@/capabilities/copilot/api/tool-use-sse';

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

  it('forwards DomainTool tool_use frames unchanged', () => {
    const call = {
      toolName: 'query_mistakes',
      toolUseId: 'toolu-query-7',
      input: { limit: 8, subject_id: 'math' },
    };

    expect(sanitizeToolUseForSse(call)).toEqual(call);
  });

  it('drops Task tool_result frames defensively', () => {
    expect(
      sanitizeToolResultForSse({
        toolName: 'Task',
        input: { subagent_type: 'copilot-researcher', prompt: 'hidden' },
        summary: 'should not reach the dock',
      }),
    ).toBeNull();
  });

  it('forwards DomainTool tool_result frames unchanged', () => {
    const result = {
      toolName: 'get_review_due',
      input: { horizon_days: 2 },
      summary: 'review · 12 due 今日 · 4 due 明日',
    };

    expect(sanitizeToolResultForSse(result)).toEqual(result);
  });
});
