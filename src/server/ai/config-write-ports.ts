// YUK-1869 — 配置写面需要的 AI 事实与已声明验证接口（AI owner 侧实现）。
//
// core/config/server/write 只认识 ConfigWritePorts 的结构；provider 注册表、
// 任务 catalog、pi adapter 与推理档解析都属于 AI/任务 owner，在这里绑定真实
// 函数，组合根 boot 时经 installConfigWritePorts 注入。行为与原来直接调用
// 完全一致（同一批函数、同一参数），只是依赖方向反转。

import type { TaskDefinition } from '@/ai/task-spec';
import { SOLVE_LANE_TASK_KINDS } from '@/capabilities/practice/public';
import { type TaskKind, tasks } from '@/capabilities/task-registry';
import type { ConfigWritePorts } from '@/core/config/server/write';
import { assertModelProfileCapabilityFit } from './model-profiles';
import { createLoomPiModels } from './pi-models';
import { piProviderId } from './pi-provider-catalog';
import { PROVIDER_ATTEMPT_ADMISSION_LANES } from './provider-attempt-admission-config';
import {
  ANTHROPIC_SUB_DEFAULT_MODEL,
  type Provider,
  type TaskReasoningConfig,
  isProviderImplemented,
  isProviderImplementedForTask,
  providerRequiresExplicitModel,
  readProviderId,
  resolveGlobalProviderSwitch,
  resolveTaskReasoning,
} from './providers';
import { VISION_JUDGE_TASK_KINDS } from './vision-judge-config';

/** Serialized task-catalog facts for the config write validator; no TaskDefinition behavior. */
function taskWriteFacts(): ConfigWritePorts['tasks'] {
  return Object.fromEntries(
    Object.entries(tasks).map(([kind, def]) => [
      kind,
      {
        ...('execution' in def ? { execution: def.execution } : {}),
        ...(def.ignoreGlobalPin === true ? { ignoreGlobalPin: true } : {}),
        defaultProvider: def.defaultProvider,
        defaultModel: def.defaultModel,
      },
    ]),
  );
}

export function configWritePorts(): ConfigWritePorts {
  return {
    tasks: taskWriteFacts(),
    solveLaneTaskKinds: SOLVE_LANE_TASK_KINDS,
    visionJudgeTaskKinds: VISION_JUDGE_TASK_KINDS,
    providerAttemptAdmissionLanes: PROVIDER_ATTEMPT_ADMISSION_LANES,
    anthropicSubDefaultModel: ANTHROPIC_SUB_DEFAULT_MODEL,
    readProviderId,
    isProviderImplemented: (provider) => isProviderImplemented(provider as Provider),
    isProviderImplementedForTask: (provider, kind) =>
      isProviderImplementedForTask(provider as Provider, kind as TaskKind),
    providerRequiresExplicitModel: (provider) =>
      providerRequiresExplicitModel(provider as Provider),
    resolveGlobalProviderSwitch,
    resolveTaskReasoning: (kind, provider, model, stored) =>
      resolveTaskReasoning(
        kind as TaskKind,
        provider as Provider,
        model,
        stored as TaskReasoningConfig | undefined,
      ),
    assertModelProfileCapabilityFit: (kind, provider, model) =>
      assertModelProfileCapabilityFit(
        (tasks as Record<string, TaskDefinition>)[kind],
        provider as Provider,
        model,
      ),
    createPairModels: () => createLoomPiModels(),
    piProviderId: (provider) => piProviderId(provider as Provider),
  };
}
