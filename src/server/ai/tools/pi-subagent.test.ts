// YUK-921 P3 (YUK-1022) — pi-side spawn-contract units. Pure no-DB: the spec
// mapping, the PiHookBridge gate and the Task/Agent AgentTool are all
// synchronous/promise-shaped over the shared SpawnDecider — no engine, no
// network. The equivalence pin (same decider → same decision across both
// engine surfaces) is the heart of the dual-descriptor contract.

import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '../sdk-types';
import { SPAWN_BUDGET_MODE, SPAWN_TOOL_ALIASES, createSpawnDecider } from '../spawn-contract';
import {
  type PiSubagentHost,
  buildPiSpawnAgentTools,
  createPiSpawnContract,
  toPiSubagentSpecs,
} from './pi-subagent';

const signal = new AbortController().signal;

function agentsFixture(): Record<string, AgentDefinition> {
  return {
    'diagnostic-scout': {
      description: '只读核对作答证据，回报结论与 event refs',
      prompt: '比较错题与复习轨迹；区分必要条件、充分条件及逆命题。',
      tools: ['mcp__copilot__get_attempt_details', 'Task', 'mcp__copilot__get_probe_history'],
      disallowedTools: ['mcp__copilot__propose_change'],
      maxTurns: 8,
    },
    'question-preview-author': {
      description: '生成两道不落库的高判别力预览题',
      prompt: '基于同一错因生成符号与门禁情境两道题，只回结构化预览。',
      model: 'inherit',
    },
  };
}

describe('toPiSubagentSpecs — depth-one spec mapping', () => {
  it('carries the engine-neutral fields and strips spawn tools from the child surface', () => {
    const specs = toPiSubagentSpecs(agentsFixture());
    const scout = specs['diagnostic-scout'];
    expect(scout).toEqual({
      description: '只读核对作答证据，回报结论与 event refs',
      prompt: '比较错题与复习轨迹；区分必要条件、充分条件及逆命题。',
      // 'Task' filtered out of the inherited allowlist…
      tools: ['mcp__copilot__get_attempt_details', 'mcp__copilot__get_probe_history'],
      // …and both spawn aliases land in disallowedTools (depth-one is structural).
      disallowedTools: ['mcp__copilot__propose_change', 'Agent', 'Task'],
      maxTurns: 8,
    });
    const author = specs['question-preview-author'];
    expect(author?.tools).toBeUndefined();
    expect(author?.disallowedTools).toEqual([...SPAWN_TOOL_ALIASES]);
    expect(author?.model).toBe('inherit');
  });
});

describe('createPiSpawnContract — gate over the shared decider', () => {
  const call = (name: string, id: string) => ({ id, name });
  const taskInput = {
    subagent_type: 'diagnostic-scout',
    description: '交叉核对七日错题、探针与复习轨迹',
  };

  it('ignores non-spawn tools entirely (undefined → later chain entries run)', async () => {
    const contract = createPiSpawnContract({ enabled: true, agents: agentsFixture() });
    expect(
      await contract.gate(call('mcp__copilot__get_question', 'r1'), {}, signal),
    ).toBeUndefined();
    expect(contract.readBudgetReport().observedAttempts).toBe(0);
  });

  it('returns {block:false} on allow — the authoritative defined result', async () => {
    const contract = createPiSpawnContract({ enabled: true, agents: agentsFixture() });
    for (const name of SPAWN_TOOL_ALIASES) {
      expect(await contract.gate(call(name, `allow-${name}`), taskInput, signal)).toEqual({
        block: false,
      });
    }
  });

  it('maps every deny decision to {block:true, reason} — never terminate (SDK deny is an error tool result)', async () => {
    const contract = createPiSpawnContract({
      enabled: false,
      agents: agentsFixture(),
      disabledReason: 'COPILOT_SUBAGENT_ENABLED 未开启',
    });
    const denied = await contract.gate(call('Task', 'd1'), taskInput, signal);
    expect(denied).toEqual({ block: true, reason: 'COPILOT_SUBAGENT_ENABLED 未开启' });
    expect(denied).not.toHaveProperty('terminate');
  });

  it('denies unknown agents and model/isolation/name/background overrides with the SDK wording', async () => {
    const contract = createPiSpawnContract({ enabled: true, agents: agentsFixture() });
    expect(
      await contract.gate(call('Task', 'u1'), { ...taskInput, subagent_type: 'rogue' }, signal),
    ).toMatchObject({ block: true, reason: expect.stringContaining('unknown subagent_type') });
    const overrides = [
      { model: 'opus' },
      { isolation: 'worktree' },
      { name: 'team-lead' },
      { run_in_background: true },
    ];
    for (const [i, override] of overrides.entries()) {
      expect(
        await contract.gate(call('Agent', `override-${i}`), { ...taskInput, ...override }, signal),
      ).toEqual({
        block: true,
        reason: 'Agent model/isolation/name/background overrides are not allowed',
      });
    }
    expect(contract.readBudgetReport()).toMatchObject({
      mode: SPAWN_BUDGET_MODE,
      observedAttempts: 5,
      allowedAttempts: 0,
      // unknown-agent + the four override attempts are all contract denials.
      deniedByContract: 5,
      deniedByKillSwitch: 0,
    });
  });

  it('memoizes gate decisions on the shared decider — same call id, one observation', async () => {
    const observations = vi.fn();
    const options = { enabled: true, agents: agentsFixture(), onBudgetObservation: observations };
    const pi = createPiSpawnContract(options, createSpawnDecider(options));

    const first = await pi.gate(call('Task', 'shared-01'), { subagent_type: 'ghost' }, signal);
    const retry = await pi.gate(call('Task', 'shared-01'), { subagent_type: 'ghost' }, signal);

    expect(first).toMatchObject({ block: true });
    expect(retry).toEqual(first);
    expect(observations).toHaveBeenCalledTimes(1);
  });
});

describe('buildPiSpawnAgentTools — Task/Agent AgentTool surface', () => {
  const specs = toPiSubagentSpecs(agentsFixture());

  function hostReturning(text: string) {
    const calls: Parameters<PiSubagentHost['runNested']>[0][] = [];
    const host: PiSubagentHost = {
      runNested: async (input) => {
        calls.push(input);
        return text;
      },
    };
    return { host, calls };
  }

  it('builds both SDK alias names with the declared roster in the description', () => {
    const { host } = hostReturning('ok');
    const tools = buildPiSpawnAgentTools(specs, host);
    expect(tools.map((t) => t.name)).toEqual([...SPAWN_TOOL_ALIASES]);
    for (const tool of tools) {
      expect(tool.description).toContain('diagnostic-scout');
      expect(tool.description).toContain('question-preview-author');
    }
  });

  it('hands the tool call to the host and returns its text as the tool result', async () => {
    const { host, calls } = hostReturning('scout report body');
    const task = buildPiSpawnAgentTools(specs, host).find((t) => t.name === 'Task');
    const result = await task?.execute(
      'call_sub_1',
      { subagent_type: 'diagnostic-scout', description: '核对证据', prompt: '去核对' },
      signal,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolCallId: 'call_sub_1',
      subagentType: 'diagnostic-scout',
      description: '核对证据',
      prompt: '去核对',
      spec: specs['diagnostic-scout'],
      signal,
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'scout report body' }],
      details: null,
    });
  });

  it('rejects an undeclared subagent_type inside execute (gate is the first line, this is the second)', async () => {
    const { host, calls } = hostReturning('unused');
    const task = buildPiSpawnAgentTools(specs, host).find((t) => t.name === 'Task');
    await expect(
      task?.execute(
        'call_sub_2',
        { subagent_type: 'rogue', description: 'd', prompt: 'p' },
        signal,
      ),
    ).rejects.toThrow(/unknown subagent_type/);
    expect(calls).toHaveLength(0);
  });

  it('propagates host failures so the loop settles an error tool result (SDK Task parity)', async () => {
    const host: PiSubagentHost = {
      runNested: async () => {
        throw new Error('child loop exploded');
      },
    };
    const task = buildPiSpawnAgentTools(specs, host).find((t) => t.name === 'Agent');
    await expect(
      task?.execute(
        'call_sub_3',
        { subagent_type: 'diagnostic-scout', description: 'd', prompt: 'p' },
        signal,
      ),
    ).rejects.toThrow('child loop exploded');
  });
});
