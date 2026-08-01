import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { SPAWN_BUDGET_MODE, SPAWN_TOOL_NAME, createSpawnContract } from './spawn-contract';

const signal = new AbortController().signal;

function taskHookInput(toolUseId: string, toolName = SPAWN_TOOL_NAME) {
  return {
    hook_event_name: 'PreToolUse' as const,
    tool_name: toolName,
    tool_input: {
      subagent_type: 'diagnostic-scout',
      description: '交叉核对七日错题、探针与复习轨迹中的必要条件/充分条件混淆',
    },
    tool_use_id: toolUseId,
    session_id: 'copilot-session-2026-08-01-complex-01',
    transcript_path: '/tmp/isolated-product-session.jsonl',
    cwd: '/srv/loom',
    permission_mode: 'bypassPermissions' as const,
  };
}

function permissionOptions(toolUseId: string) {
  return {
    signal,
    toolUseID: toolUseId,
    requestId: `permission-${toolUseId}`,
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

describe('createSpawnContract — YUK-757/YUK-572 v2', () => {
  it('observes an unbounded interleaving report-only while hook/canUseTool stay idempotent per toolUseID', async () => {
    const observations = vi.fn();
    const originalAgents = agentsFixture();
    const contract = createSpawnContract({
      enabled: true,
      agents: originalAgents,
      onBudgetObservation: observations,
    });
    const hook = contract.hooks.PreToolUse?.[0]?.hooks[0];
    expect(hook).toBeTypeOf('function');
    if (!hook) throw new Error('missing PreToolUse spawn hook');

    // The SDK may consult canUseTool first for one call and PreToolUse first for
    // another. It may also re-consult either layer. Correlation IDs, not callback
    // order, define uniqueness.
    const firstPermission = await contract.canUseTool(
      SPAWN_TOOL_NAME,
      taskHookInput('spawn-diagnostic-01').tool_input,
      permissionOptions('spawn-diagnostic-01'),
    );
    const readHook = await hook(
      taskHookInput('read-attempt-01', 'mcp__copilot__get_attempt_details'),
      'read-attempt-01',
      { signal },
    );
    const secondHook = await hook(taskHookInput('spawn-author-02'), 'spawn-author-02', {
      signal,
    });
    const secondPermission = await contract.canUseTool(
      SPAWN_TOOL_NAME,
      taskHookInput('spawn-author-02').tool_input,
      permissionOptions('spawn-author-02'),
    );
    const firstHookRetry = await hook(taskHookInput('spawn-diagnostic-01'), 'spawn-diagnostic-01', {
      signal,
    });
    const thirdPermission = await contract.canUseTool(
      SPAWN_TOOL_NAME,
      taskHookInput('spawn-counterexample-03').tool_input,
      permissionOptions('spawn-counterexample-03'),
    );

    expect(firstPermission).toMatchObject({ behavior: 'allow' });
    expect(readHook).toMatchObject({ continue: true });
    expect(secondHook).toMatchObject({ continue: true });
    expect(secondPermission).toMatchObject({ behavior: 'allow' });
    expect(firstHookRetry).toMatchObject({ continue: true });
    // v1's MAX_SCOUT_SPAWNS=1 is deliberately retired: the third distinct spawn is
    // observed, not denied. A future hard number needs a week of real observations.
    expect(thirdPermission).toMatchObject({ behavior: 'allow' });

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
    expect(contract.readBudgetReport()).toEqual({
      mode: SPAWN_BUDGET_MODE,
      observedAttempts: 3,
      allowedAttempts: 3,
      deniedByKillSwitch: 0,
      deniedByContract: 0,
      toolUseIds: ['spawn-diagnostic-01', 'spawn-author-02', 'spawn-counterexample-03'],
    });

    // The contract does not mutate caller-owned definitions. It returns depth-one
    // definitions: explicit Task is removed and inherited surfaces hard-disallow Task.
    expect(originalAgents['diagnostic-scout']?.tools).toContain(SPAWN_TOOL_NAME);
    expect(contract.agents['diagnostic-scout']?.tools).toEqual([
      'mcp__copilot__get_attempt_details',
      'mcp__copilot__get_probe_history',
    ]);
    expect(contract.agents['diagnostic-scout']?.disallowedTools).toEqual([
      'mcp__copilot__propose_change',
      SPAWN_TOOL_NAME,
    ]);
    expect(contract.agents['question-preview-author']?.tools).toBeUndefined();
    expect(contract.agents['question-preview-author']?.disallowedTools).toEqual([SPAWN_TOOL_NAME]);
  });

  it('fails the spawn surface closed when the kill switch is off without touching non-Task tools', async () => {
    const observations = vi.fn();
    const contract = createSpawnContract({
      enabled: false,
      agents: agentsFixture(),
      disabledReason: 'COPILOT_SUBAGENT_ENABLED 未开启',
      onBudgetObservation: observations,
    });
    const hook = contract.hooks.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('missing PreToolUse spawn hook');

    const deniedByHook = await hook(taskHookInput('spawn-disabled-01'), 'spawn-disabled-01', {
      signal,
    });
    const sameCallDeniedByPermission = await contract.canUseTool(
      SPAWN_TOOL_NAME,
      taskHookInput('spawn-disabled-01').tool_input,
      permissionOptions('spawn-disabled-01'),
    );
    const ordinaryRead = await contract.canUseTool(
      'mcp__copilot__get_question',
      { question_id: 'q_logic_counterexample_17' },
      permissionOptions('read-question-17'),
    );

    expect(deniedByHook).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'COPILOT_SUBAGENT_ENABLED 未开启',
      },
    });
    expect(sameCallDeniedByPermission).toEqual({
      behavior: 'deny',
      message: 'COPILOT_SUBAGENT_ENABLED 未开启',
    });
    expect(ordinaryRead).toMatchObject({ behavior: 'allow' });
    expect(observations).toHaveBeenCalledTimes(1);
    expect(contract.readBudgetReport()).toEqual({
      mode: SPAWN_BUDGET_MODE,
      observedAttempts: 1,
      allowedAttempts: 0,
      deniedByKillSwitch: 1,
      deniedByContract: 0,
      toolUseIds: ['spawn-disabled-01'],
    });
  });

  it('rejects fallback agents and model/isolation overrides instead of escaping the declared surface', async () => {
    const observations = vi.fn();
    const contract = createSpawnContract({
      enabled: true,
      agents: agentsFixture(),
      onBudgetObservation: observations,
    });
    const hook = contract.hooks.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('missing PreToolUse spawn hook');

    const unknownAgent = taskHookInput('spawn-unknown-general-purpose');
    unknownAgent.tool_input.subagent_type = 'general-purpose';
    const unknownHook = await hook(unknownAgent, unknownAgent.tool_use_id, { signal });
    const unknownPermission = await contract.canUseTool(
      SPAWN_TOOL_NAME,
      unknownAgent.tool_input,
      permissionOptions(unknownAgent.tool_use_id),
    );
    const modelOverride = await contract.canUseTool(
      SPAWN_TOOL_NAME,
      {
        subagent_type: 'diagnostic-scout',
        model: 'opus',
        description: '尝试绕开定义中的角色模型分级',
      },
      permissionOptions('spawn-model-override'),
    );
    const isolationOverride = await hook(
      {
        ...taskHookInput('spawn-isolation-override'),
        tool_input: {
          subagent_type: 'question-preview-author',
          isolation: 'worktree',
          description: '尝试请求产品 runtime 未批准的隔离形态',
        },
      },
      'spawn-isolation-override',
      { signal },
    );

    expect(unknownHook).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('unknown subagent_type'),
      },
    });
    expect(unknownPermission).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('unknown subagent_type'),
    });
    expect(modelOverride).toEqual({
      behavior: 'deny',
      message: 'Task model/isolation overrides are not allowed',
    });
    expect(isolationOverride).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Task model/isolation overrides are not allowed',
      },
    });
    expect(observations).toHaveBeenCalledTimes(3);
    expect(contract.readBudgetReport()).toEqual({
      mode: SPAWN_BUDGET_MODE,
      observedAttempts: 3,
      allowedAttempts: 0,
      deniedByKillSwitch: 0,
      deniedByContract: 3,
      toolUseIds: [
        'spawn-unknown-general-purpose',
        'spawn-model-override',
        'spawn-isolation-override',
      ],
    });
  });
});
