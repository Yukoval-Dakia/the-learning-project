import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from './sdk-types';
import {
  SPAWN_BUDGET_MODE,
  SPAWN_TOOL_ALIASES,
  SPAWN_TOOL_NAME,
  createSpawnDecider,
  isSpawnToolName,
  toDepthOneAgents,
} from './spawn-contract';

function spawnInput(subagentType = 'diagnostic-scout') {
  return {
    subagent_type: subagentType,
    description: '交叉核对七日错题、探针与复习轨迹中的必要条件/充分条件混淆',
  };
}

function agentsFixture(): Record<string, AgentDefinition> {
  return {
    'diagnostic-scout': {
      description: '只读核对作答证据，回报结论与 event refs',
      prompt:
        '比较错题 att_logic_17、复习 review_logic_22 与 probe_logic_09；区分必要条件、充分条件及逆命题。',
      tools: [
        'mcp__copilot__get_attempt_details',
        SPAWN_TOOL_NAME,
        'mcp__copilot__get_probe_history',
      ],
      disallowedTools: ['mcp__copilot__propose_change'],
      maxTurns: 8,
    },
    'question-preview-author': {
      description: '生成两道不落库的高判别力预览题',
      prompt: '基于同一错因生成符号与门禁情境两道题，只回结构化预览；不得写题库、不得再委派。',
      // Omitted tools normally inherit the parent surface. The shared contract must
      // still make the nested agent depth=1 instead of inheriting Task as well.
      model: 'inherit',
    },
  };
}

describe('spawn contract — YUK-757/YUK-572 v2 (engine-neutral decider)', () => {
  it('observes an unbounded interleaving report-only while decisions stay idempotent per toolUseID', () => {
    const observations = vi.fn();
    const originalAgents = agentsFixture();
    const decider = createSpawnDecider({
      enabled: true,
      agents: originalAgents,
      onBudgetObservation: observations,
    });

    // The pi beforeToolCall gate filters non-spawn tool names via
    // isSpawnToolName before consulting the decider, so only Task/Agent inputs
    // reach here. Correlation IDs, not callback order, define uniqueness.
    const first = decider.decide('spawn-diagnostic-01', spawnInput('diagnostic-scout'));
    const second = decider.decide('spawn-author-02', spawnInput('question-preview-author'));
    const firstRetry = decider.decide('spawn-diagnostic-01', spawnInput('diagnostic-scout'));
    const third = decider.decide('spawn-counterexample-03', spawnInput('diagnostic-scout'));

    expect(first).toEqual({ decision: 'allow' });
    expect(second).toEqual({ decision: 'allow' });
    expect(firstRetry).toEqual({ decision: 'allow' });
    // v1's MAX_SCOUT_SPAWNS=1 is deliberately retired: the third distinct spawn is
    // observed, not denied. A future hard number needs a week of real observations.
    expect(third).toEqual({ decision: 'allow' });

    expect(observations.mock.calls.map(([entry]) => entry)).toEqual([
      {
        mode: SPAWN_BUDGET_MODE,
        toolUseId: 'spawn-diagnostic-01',
        ordinal: 1,
        decision: 'allow',
      },
      {
        mode: SPAWN_BUDGET_MODE,
        toolUseId: 'spawn-author-02',
        ordinal: 2,
        decision: 'allow',
      },
      {
        mode: SPAWN_BUDGET_MODE,
        toolUseId: 'spawn-counterexample-03',
        ordinal: 3,
        decision: 'allow',
      },
    ]);
    expect(decider.readBudgetReport()).toEqual({
      mode: SPAWN_BUDGET_MODE,
      observedAttempts: 3,
      allowedAttempts: 3,
      deniedByKillSwitch: 0,
      deniedByContract: 0,
      toolUseIds: ['spawn-diagnostic-01', 'spawn-author-02', 'spawn-counterexample-03'],
    });

    // The contract does not mutate caller-owned definitions. Depth-one
    // reduction removes explicit Task and hard-disallows it on inherited surfaces.
    const reduced = toDepthOneAgents(originalAgents);
    expect(originalAgents['diagnostic-scout']?.tools).toContain(SPAWN_TOOL_NAME);
    expect(reduced['diagnostic-scout']?.tools).toEqual([
      'mcp__copilot__get_attempt_details',
      'mcp__copilot__get_probe_history',
    ]);
    expect(reduced['diagnostic-scout']?.disallowedTools).toEqual([
      'mcp__copilot__propose_change',
      ...SPAWN_TOOL_ALIASES,
    ]);
    expect(reduced['question-preview-author']?.tools).toBeUndefined();
    expect(reduced['question-preview-author']?.disallowedTools).toEqual([...SPAWN_TOOL_ALIASES]);
    expect(reduced['diagnostic-scout']?.background).toBe(false);
    expect(reduced['question-preview-author']?.background).toBe(false);
  });

  it('fails the spawn surface closed when the kill switch is off', () => {
    const observations = vi.fn();
    const decider = createSpawnDecider({
      enabled: false,
      agents: agentsFixture(),
      disabledReason: 'COPILOT_SUBAGENT_ENABLED 未开启',
      onBudgetObservation: observations,
    });

    const denied = decider.decide('spawn-disabled-01', spawnInput('diagnostic-scout'));
    const sameCallRetry = decider.decide('spawn-disabled-01', spawnInput('diagnostic-scout'));

    expect(denied).toEqual({
      decision: 'deny_kill_switch',
      message: 'COPILOT_SUBAGENT_ENABLED 未开启',
    });
    expect(sameCallRetry).toEqual(denied);
    // Non-spawn tool names are filtered upstream by the pi gate.
    expect(isSpawnToolName('mcp__copilot__get_question')).toBe(false);
    expect(isSpawnToolName('Task')).toBe(true);
    expect(isSpawnToolName('Agent')).toBe(true);
    expect(observations).toHaveBeenCalledTimes(1);
    expect(decider.readBudgetReport()).toEqual({
      mode: SPAWN_BUDGET_MODE,
      observedAttempts: 1,
      allowedAttempts: 0,
      deniedByKillSwitch: 1,
      deniedByContract: 0,
      toolUseIds: ['spawn-disabled-01'],
    });
  });

  it('rejects fallback agents and model/isolation/name/background overrides instead of escaping the declared surface', () => {
    const observations = vi.fn();
    const decider = createSpawnDecider({
      enabled: true,
      agents: agentsFixture(),
      onBudgetObservation: observations,
    });

    const unknownAgent = decider.decide('spawn-unknown-general-purpose', {
      subagent_type: 'general-purpose',
      description: '尝试未登记的兜底角色',
    });
    const modelOverride = decider.decide('spawn-model-override', {
      subagent_type: 'diagnostic-scout',
      model: 'opus',
      description: '尝试绕开定义中的角色模型分级',
    });
    const isolationOverride = decider.decide('spawn-isolation-override', {
      subagent_type: 'question-preview-author',
      isolation: 'worktree',
      description: '尝试请求产品 runtime 未批准的隔离形态',
    });
    const backgroundOverride = decider.decide('spawn-background-override', {
      subagent_type: 'diagnostic-scout',
      run_in_background: true,
      description: '尝试让父 Copilot 不等结论便提前结束',
    });
    const nameOverride = decider.decide('spawn-name-override', {
      subagent_type: 'diagnostic-scout',
      name: 'parallel-researcher',
      description: '尝试进入继承的 agent-team 分支而不阻塞父回复',
    });

    expect(unknownAgent).toMatchObject({
      decision: 'deny_unknown_agent',
      message: expect.stringContaining('unknown subagent_type'),
    });
    for (const denied of [modelOverride, isolationOverride, backgroundOverride, nameOverride]) {
      expect(denied).toEqual({
        decision: 'deny_input_override',
        message: 'Agent model/isolation/name/background overrides are not allowed',
      });
    }
    expect(observations).toHaveBeenCalledTimes(5);
    expect(decider.readBudgetReport()).toEqual({
      mode: SPAWN_BUDGET_MODE,
      observedAttempts: 5,
      allowedAttempts: 0,
      deniedByKillSwitch: 0,
      deniedByContract: 5,
      toolUseIds: [
        'spawn-unknown-general-purpose',
        'spawn-model-override',
        'spawn-isolation-override',
        'spawn-background-override',
        'spawn-name-override',
      ],
    });
  });
});
