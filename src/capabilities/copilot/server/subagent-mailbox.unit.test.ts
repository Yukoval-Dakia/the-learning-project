import { describe, expect, it } from 'vitest';
import { SPAWN_TOOL_NAME } from '@/server/ai/spawn-contract';
import { copilotTaskSpec } from '../tasks/agent';

describe('Copilot native research contracts (YUK-939)', () => {
  it('keeps the parent prompt on one native child result channel', () => {
    expect(copilotTaskSpec.definition.prompt.text).toContain(
      'subagent_type 固定为 copilot-researcher',
    );
    expect(copilotTaskSpec.definition.prompt.text).toContain('tool_result');
    expect(copilotTaskSpec.definition.prompt.text).not.toContain('launch_researcher({launch_key');
    expect(copilotTaskSpec.definition.prompt.text).not.toContain('自动 continuation');
  });

  it('uses native Task under the parent budget', () => {
    expect(SPAWN_TOOL_NAME).toBe('Task');
    expect(copilotTaskSpec.definition.budget.maxIterations).toBeGreaterThan(0);
  });
});
