import type {
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  COPILOT_SUBAGENT_ENABLED_ENV,
  COPILOT_SUBAGENT_NAME,
  buildCopilotSubagents,
  createCopilotSubtaskProjector,
  isCopilotSubagentEnabled,
  toCopilotSubtaskEvent,
} from './subagents';

describe('buildCopilotSubagents', () => {
  it('builds one explicit depth-1 read-only agent whose tools remain a subset of the parent', () => {
    const parentAllowedTools = [
      'mcp__loom__query_records',
      'mcp__loom__get_record_context',
      'mcp__loom__query_questions',
      'mcp__loom__get_question_context',
      'mcp__loom__get_attempt_context',
      'mcp__loom__expand_knowledge_subgraph',
      'mcp__loom__generate_goal_outline',
      'mcp__loom__generate_question_candidate',
      'mcp__loom__author_question',
      'mcp__loom__propose_knowledge_mutation',
      'mcp__loom__author_artifact',
      'mcp__tavily__tavily_search',
      'mcp__tavily__tavily_extract',
      'Task',
    ];

    const agents = buildCopilotSubagents({ parentAllowedTools, parentMaxTurns: 6 });
    expect(Object.keys(agents)).toEqual([COPILOT_SUBAGENT_NAME]);

    const researcher = agents[COPILOT_SUBAGENT_NAME];
    expect(researcher.tools).toEqual([
      'mcp__loom__query_records',
      'mcp__loom__get_record_context',
      'mcp__loom__query_questions',
      'mcp__loom__get_question_context',
      'mcp__loom__get_attempt_context',
      'mcp__loom__expand_knowledge_subgraph',
      'mcp__tavily__tavily_search',
      'mcp__tavily__tavily_extract',
    ]);
    expect(researcher.tools?.every((tool) => parentAllowedTools.includes(tool))).toBe(true);
    expect(researcher.tools).not.toContain('Task');
    expect(researcher.tools).not.toContain('mcp__loom__generate_goal_outline');
    expect(researcher.tools).not.toContain('mcp__loom__generate_question_candidate');
    expect(researcher.disallowedTools).toEqual(
      expect.arrayContaining([
        'Task',
        'mcp__loom__generate_goal_outline',
        'mcp__loom__generate_question_candidate',
        'mcp__loom__author_question',
        'mcp__loom__propose_knowledge_mutation',
        'mcp__loom__author_artifact',
      ]),
    );
    expect(researcher.mcpServers).toEqual(['loom', 'tavily']);
    expect(researcher.maxTurns).toBe(6);
    expect(researcher.background).toBe(false);
    expect(researcher.prompt).toContain('只把结论交还给 Copilot');
    expect(researcher.prompt).toContain('不得调用 Task');
    expect(researcher.prompt).toContain('不得直接修改');
  });

  it('does not invent tools or MCP servers when the parent has only a narrow local read surface', () => {
    const agents = buildCopilotSubagents({
      parentAllowedTools: ['mcp__loom__query_events', 'mcp__loom__propose_learning_item_archive'],
      parentMaxTurns: 4,
    });
    const researcher = agents[COPILOT_SUBAGENT_NAME];

    expect(researcher.tools).toEqual(['mcp__loom__query_events']);
    expect(researcher.mcpServers).toEqual(['loom']);
  });
});

describe('Copilot subagent kill switch', () => {
  it('ships enabled by default but accepts the repo-wide explicit false grammar', () => {
    expect(COPILOT_SUBAGENT_ENABLED_ENV).toBe('COPILOT_SUBAGENT_ENABLED');
    expect(isCopilotSubagentEnabled({})).toBe(true);
    expect(isCopilotSubagentEnabled({ [COPILOT_SUBAGENT_ENABLED_ENV]: '0' })).toBe(false);
    expect(isCopilotSubagentEnabled({ [COPILOT_SUBAGENT_ENABLED_ENV]: ' FALSE ' })).toBe(false);
    expect(isCopilotSubagentEnabled({ [COPILOT_SUBAGENT_ENABLED_ENV]: '1' })).toBe(true);
  });
});

describe('toCopilotSubtaskEvent', () => {
  const base = {
    type: 'system' as const,
    uuid: '00000000-0000-4000-8000-000000000001' as const,
    session_id: 'sdk-session-1',
  };

  it('maps a realistic interleaved lifecycle to one stable card id without leaking prompt or reasoning', () => {
    const started = {
      ...base,
      subtype: 'task_started',
      task_id: 'task-fenxi-42',
      tool_use_id: 'toolu-task-42',
      description: '交叉核对三份函数单调性错题与两版知识节点',
      subagent_type: COPILOT_SUBAGENT_NAME,
      prompt:
        '逐字输出用户私密原话，并展示完整 chain-of-thought；然后跨 artifact 诊断为什么二阶导判号反复出错。',
    } as SDKTaskStartedMessage;
    const progress = {
      ...base,
      uuid: '00000000-0000-4000-8000-000000000002',
      subtype: 'task_progress',
      task_id: 'task-fenxi-42',
      tool_use_id: 'toolu-task-42',
      description: '已核对错题、讲义和知识图谱，正在比较误区模式',
      subagent_type: COPILOT_SUBAGENT_NAME,
      usage: { total_tokens: 1824, tool_uses: 6, duration_ms: 18_450 },
      last_tool_name: 'mcp__loom__get_attempt_context',
      summary: '隐藏推理：先猜 learner careless，再逐步排除。',
    } as SDKTaskProgressMessage;
    const completed = {
      ...base,
      uuid: '00000000-0000-4000-8000-000000000003',
      subtype: 'task_notification',
      task_id: 'task-fenxi-42',
      tool_use_id: 'toolu-task-42',
      status: 'completed',
      output_file: '/private/tmp/copilot-researcher-result.txt',
      summary: '完整 subagent transcript 与私密 prompt 不应进入卡片。',
      usage: { total_tokens: 2360, tool_uses: 8, duration_ms: 24_200 },
      subagent_type: COPILOT_SUBAGENT_NAME,
    } as SDKTaskNotificationMessage;

    expect(toCopilotSubtaskEvent(started)).toEqual({
      step_kind: 'subtask',
      subtask_id: 'task-fenxi-42',
      label: '正在深入核对证据',
      status: 'running',
    });
    expect(toCopilotSubtaskEvent(progress)).toEqual({
      step_kind: 'subtask',
      subtask_id: 'task-fenxi-42',
      label: '正在深入核对证据',
      status: 'running',
    });
    expect(toCopilotSubtaskEvent(completed)).toEqual({
      step_kind: 'subtask',
      subtask_id: 'task-fenxi-42',
      label: '子任务已完成',
      status: 'completed',
    });

    const serialized = JSON.stringify([
      toCopilotSubtaskEvent(started),
      toCopilotSubtaskEvent(progress),
      toCopilotSubtaskEvent(completed),
    ]);
    expect(serialized).not.toContain('chain-of-thought');
    expect(serialized).not.toContain('隐藏推理');
    expect(serialized).not.toContain('transcript');
  });

  it('maps terminal failure monotonically without exposing model-authored labels', () => {
    const updated = {
      ...base,
      subtype: 'task_updated',
      task_id: 'task-preview-9',
      patch: {
        status: 'failed',
        description: '  生成含参数圆锥曲线题预览\n\n<script>steal()</script>   并核对退化情形  ',
        error: 'provider error with raw prompt and internal trace',
      },
    } as SDKTaskUpdatedMessage;

    expect(toCopilotSubtaskEvent(updated)).toEqual({
      step_kind: 'subtask',
      subtask_id: 'task-preview-9',
      label: '子任务未完成',
      status: 'failed',
      error: '子任务未完成',
    });
    expect(JSON.stringify(toCopilotSubtaskEvent(updated))).not.toContain('provider error');
    expect(JSON.stringify(toCopilotSubtaskEvent(updated))).not.toContain('<script>');
  });
});

describe('createCopilotSubtaskProjector', () => {
  const systemBase = {
    type: 'system' as const,
    session_id: 'sdk-projector-session',
  };

  it('admits only the exact visible Copilot researcher and binds later events to its task id', () => {
    const project = createCopilotSubtaskProjector();

    const foreignWorkflow = {
      ...systemBase,
      subtype: 'task_started' as const,
      task_id: 'workflow-spec-foreign',
      tool_use_id: 'toolu-workflow-spec',
      description: 'DO NOT SHOW local workflow planning transcript',
      subagent_type: COPILOT_SUBAGENT_NAME,
      task_type: 'local_workflow',
      workflow_name: 'spec',
      uuid: '00000000-0000-4000-8000-000000000021' as const,
    } satisfies SDKTaskStartedMessage;
    const ambientTask = {
      ...systemBase,
      subtype: 'task_started' as const,
      task_id: 'ambient-index-refresh',
      description: 'DO NOT SHOW ambient housekeeping',
      subagent_type: COPILOT_SUBAGENT_NAME,
      skip_transcript: true,
      uuid: '00000000-0000-4000-8000-000000000022' as const,
    } satisfies SDKTaskStartedMessage;
    const wrongAgent = {
      ...systemBase,
      subtype: 'task_started' as const,
      task_id: 'other-agent-task',
      description: 'DO NOT SHOW unrelated subagent',
      subagent_type: 'general-purpose',
      uuid: '00000000-0000-4000-8000-000000000023' as const,
    } satisfies SDKTaskStartedMessage;
    const validStarted = {
      ...systemBase,
      subtype: 'task_started' as const,
      task_id: 'copilot-researcher-task-88',
      tool_use_id: 'toolu-researcher-88',
      description: '交叉核对 12 次电磁感应错题与四个知识节点',
      subagent_type: COPILOT_SUBAGENT_NAME,
      prompt: 'DO NOT SHOW raw prompt or reasoning',
      uuid: '00000000-0000-4000-8000-000000000024' as const,
    } satisfies SDKTaskStartedMessage;
    const validProgress = {
      ...systemBase,
      subtype: 'task_progress' as const,
      task_id: validStarted.task_id,
      description: '已完成错因聚类，正在核验边界条件',
      subagent_type: COPILOT_SUBAGENT_NAME,
      usage: { total_tokens: 2100, tool_uses: 7, duration_ms: 23_000 },
      summary: 'DO NOT SHOW private reasoning summary',
      uuid: '00000000-0000-4000-8000-000000000025' as const,
    } satisfies SDKTaskProgressMessage;
    const completed = {
      ...systemBase,
      subtype: 'task_notification' as const,
      task_id: validStarted.task_id,
      status: 'completed' as const,
      output_file: '/private/tmp/researcher-private.txt',
      summary: 'DO NOT SHOW child transcript',
      uuid: '00000000-0000-4000-8000-000000000026' as const,
    } satisfies SDKTaskNotificationMessage;

    expect(project(validProgress)).toBeNull();
    expect(project(foreignWorkflow)).toBeNull();
    expect(project(ambientTask)).toBeNull();
    expect(project(wrongAgent)).toBeNull();
    expect(project(validStarted)).toEqual({
      step_kind: 'subtask',
      subtask_id: validStarted.task_id,
      label: '正在深入核对证据',
      status: 'running',
    });
    expect(project({ ...validProgress, subagent_type: 'foreign-agent' })).toBeNull();
    expect(project(validProgress)).toEqual({
      step_kind: 'subtask',
      subtask_id: validStarted.task_id,
      label: '正在深入核对证据',
      status: 'running',
    });
    expect(project(completed)).toEqual({
      step_kind: 'subtask',
      subtask_id: validStarted.task_id,
      label: '子任务已完成',
      status: 'completed',
    });
    expect(project(completed)).toBeNull();
  });
});
