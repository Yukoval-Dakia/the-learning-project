import { describe, expect, it } from 'vitest';
import { SPAWN_TOOL_NAME } from '@/server/ai/spawn-contract';
import { copilotTaskSpec } from '../tasks/agent';
import { copilotResearchTaskSpec } from '../tasks/research';
import {
  cancelSubagentTool,
  getSubagentTool,
  launchResearcherTool,
  waitSubagentTool,
} from './tools/subagent-controls';

describe('Copilot native research contracts (YUK-939)', () => {
  it('keeps the durable worker child fixed, read-only, bounded, and non-recursive', () => {
    expect(copilotResearchTaskSpec.definition.kind).toBe('CopilotResearchTask');
    expect(copilotResearchTaskSpec.definition.budget).toMatchObject({
      maxIterations: 10,
      timeout: 600_000,
    });
    expect(copilotResearchTaskSpec.definition.prompt.text).toContain(
      '不得调用 Task、generate_goal_outline、generate_question_candidate、launch_researcher',
    );
    expect(copilotTaskSpec.definition.prompt.text).toContain(
      'subagent_type 固定为 copilot-researcher',
    );
    expect(copilotTaskSpec.definition.prompt.text).toContain('tool_result');
    expect(copilotTaskSpec.definition.prompt.text).not.toContain('launch_researcher({launch_key');
    expect(copilotTaskSpec.definition.prompt.text).not.toContain('自动 continuation');
    for (const tool of [
      launchResearcherTool,
      getSubagentTool,
      waitSubagentTool,
      cancelSubagentTool,
    ]) {
      expect(tool.mirrorEvent, tool.name).toBe('never');
    }
  });

  it('documents foreground inline native Task as the sole child result channel', () => {
    expect(SPAWN_TOOL_NAME).toBe('Task');
    expect(copilotTaskSpec.definition.budget.maxIterations).toBeGreaterThan(0);
  });
});
