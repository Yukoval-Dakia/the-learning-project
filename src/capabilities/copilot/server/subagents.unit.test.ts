import { describe, expect, it } from 'vitest';
import type {
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
} from '@/server/ai/sdk-types';

import { COPILOT_SUBAGENT_NAME, toCopilotSubtaskEvent } from './subagents';

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
});
