import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COPILOT_TOOLS, resolveDomainToolNames } from '@/kernel/tools/allowlists';
import { copilotTaskSpec } from '../tasks/agent';
import { copilotResearchTaskSpec } from '../tasks/research';
import {
  cancelSubagentTool,
  getSubagentTool,
  launchResearcherTool,
  waitSubagentTool,
} from './tools/subagent-controls';

describe('durable Copilot subagent contracts', () => {
  it('mounts owner-local mailbox tools without native SDK Task on inline or durable roots', () => {
    expect(COPILOT_TOOLS).toEqual(
      expect.arrayContaining([
        'launch_researcher',
        'get_subagent',
        'wait_subagent',
        'cancel_subagent',
      ]),
    );
    for (const path of [
      new URL('./chat.ts', import.meta.url),
      new URL('../jobs/copilot_run.ts', import.meta.url),
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toContain('createSpawnContract(');
      expect(source).not.toContain('buildCopilotSubagents(');
      expect(source).not.toContain('SPAWN_TOOL_NAME');
    }
  });

  it('keeps the child fixed, read-only, bounded, and non-recursive', () => {
    expect(copilotResearchTaskSpec.definition.kind).toBe('CopilotResearchTask');
    expect(copilotResearchTaskSpec.definition.budget).toMatchObject({
      maxIterations: 10,
      timeout: 600_000,
    });
    expect(copilotResearchTaskSpec.definition.prompt.text).toContain(
      '不得调用 Task、run_task、launch_researcher',
    );
    const rootTools = resolveDomainToolNames('copilot');
    expect(rootTools).toContain('launch_researcher');
    expect(copilotTaskSpec.definition.prompt.text).toContain(
      'launch_researcher({launch_key,objective})',
    );
    expect(copilotTaskSpec.definition.prompt.text).not.toContain('run_in_background:false');
    for (const tool of [
      launchResearcherTool,
      getSubagentTool,
      waitSubagentTool,
      cancelSubagentTool,
    ]) {
      expect(tool.mirrorEvent, tool.name).toBe('never');
    }
  });
});
