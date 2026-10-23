// Runtime facts for GET /api/admin/config. This module may import truth sources
// directly and is re-invoked per request so env/hot-reload changes stay fresh.
// Effective values come from the real readers (never copied rules); non-scalar
// keys return a note, and provider rows carry only presence booleans and env names.

import { capabilities } from '@/capabilities';
import { copilotConfigEffectiveFacts } from '@/capabilities/copilot/public';
import { ingestionConfigEffectiveFacts } from '@/capabilities/ingestion/public';
import { knowledgeConfigEffectiveFacts } from '@/capabilities/knowledge/public';
import { notesConfigEffectiveFacts } from '@/capabilities/notes/public';
import type {
  AdminConfigProviderRow,
  AdminConfigRuntimeFacts,
  AdminConfigScheduleRow,
} from '@/capabilities/observability/public';
import { observabilityConfigEffectiveFacts } from '@/capabilities/observability/public';
import { practiceConfigEffectiveFacts } from '@/capabilities/practice/public';
import { type TaskKind, getLearnerLocale, tasks } from '@/capabilities/task-registry';
import type { ConfigEffectiveFact } from '@/core/config/effective';
import { DB_POOL_MAX } from '@/db/pool';
import { projectDagMembers } from '@/kernel/manifest';
import { resolveConfig as resolveAiRateLimitConfig } from '@/kernel/request-rate-limit';
import { assertModelProfileCapabilityFit } from '@/server/ai/model-profiles';
import { piMaxRetries } from '@/server/ai/pi-agent-adapter';
import { nativePiModel, nativePiModels, piProviderId } from '@/server/ai/pi-provider-catalog';
import {
  isProviderLaneReady,
  providerAuthSurface,
  readGlobalProviderSwitch,
  resolveTaskProvider,
} from '@/server/ai/providers';
import { registeredTypedTaskBindings } from '@/server/ai/typed-primitive-runner';
import {
  VISION_JUDGE_TASK_KINDS,
  visionJudgeProviderOverride,
} from '@/server/ai/vision-judge-config';
import { INFRA_HOUSEKEEPING_SCHEDULES } from '@/server/boss/handlers';
import { EXPIRE_AGENT, EXPIRE_FAST, EXPIRE_LLM, RETENTION_7D } from '@/server/boss/queue-config';
import { resolveApiPort } from '@/server/env';
import { EVENT_SUBSCRIPTION_DISPATCH_SCHEDULE } from '@/server/event-subscriptions/dispatch-mount';
import { memoryReconcileHandoffMode } from '@/server/memory/memory-reconcile-handoff';
import { MEMORY_INFRA_SCHEDULES } from '@/server/memory/triggers';
import {
  LAYER_STAGGER_SECONDS,
  NODE_TIMEOUT_SECONDS,
  ORCHESTRATOR_CATCHUP_WINDOW_SECONDS,
  ORCHESTRATOR_CRON,
  ORCHESTRATOR_QUEUE,
  ORCHESTRATOR_TZ,
  TICK_INTERVAL_SECONDS,
} from '@/server/orchestration/constants';

/** Admission keys resolve per lane, so they expose a note instead of a scalar. */
function laneResolvedNote(reader: string): ConfigEffectiveFact {
  return {
    note: `按 lane 在读取时解析（${reader}）；无单一标量 effective，读该 reader 的解析结果`,
  };
}

/** Check the same binding/catalog/capability gates as execution, without making a request. */
function visionOverrideFacts(): { provider: ConfigEffectiveFact; model: ConfigEffectiveFact } {
  try {
    const override = visionJudgeProviderOverride();
    if (!override) {
      const absent = {
        value: null,
        note: 'override 未设置或被 reader 降级；使用标准 provider 解析链。',
      };
      return { provider: absent, model: absent };
    }
    const bindings = VISION_JUDGE_TASK_KINDS.map((kind) => {
      try {
        const binding = resolveTaskProvider(kind, override);
        if (!nativePiModel(binding.provider, binding.model))
          throw new Error('native model unavailable');
        assertModelProfileCapabilityFit(tasks[kind], binding.provider, binding.model);
        // Project only public catalog identities; never return an auth-bearing binding.
        return { kind, provider: binding.provider, model: binding.model };
      } catch {
        return { kind, provider: null, model: null };
      }
    });
    const diagnostic = bindings
      .map((binding) =>
        binding.provider === null
          ? `${binding.kind}: 解析失败（请检查 provider、模型能力与服务端凭据）`
          : `${binding.kind}: 可用（${binding.provider} / ${binding.model}）`,
      )
      .join('；');
    if (bindings.some((binding) => binding.provider === null)) {
      // One failed consumer blocks a lane-wide value without invalidating the rest.
      const incomplete = { value: null, note: diagnostic };
      return { provider: incomplete, model: incomplete };
    }
    const models = new Set(bindings.map((binding) => binding.model));
    return {
      provider: { value: override.provider, note: diagnostic },
      model:
        models.size === 1
          ? { value: bindings[0].model, note: diagnostic }
          : {
              value: null,
              note: `各视觉任务按自身配置解析到不同模型；没有单一 effective model。${diagnostic}`,
            },
    };
  } catch {
    // Never serialize a binding or arbitrary error: either can contain credentials.
    const failed = {
      value: null,
      note: '视觉 override reader 解析失败：请检查 provider、模型能力与服务端凭据；尚未取得各任务的解析结果。',
    };
    return { provider: failed, model: failed };
  }
}

/** 各 capability public 面透出的 consumer-effective 事实 + server 自有键。 */
function buildEffectiveValues(): AdminConfigRuntimeFacts['effective_values'] {
  const rateLimit = resolveAiRateLimitConfig();
  const vision = visionOverrideFacts();
  let handoffMode: ConfigEffectiveFact;
  try {
    handoffMode = { value: memoryReconcileHandoffMode() };
  } catch {
    handoffMode = {
      value: null,
      note: 'reader throws（fail-visible）：非法值在消费点报错，不静默回退',
    };
  }
  // lane.global.* must come from readGlobalProviderSwitch (env/DB merge + provider
  // gate): model-only config is not consumed, and unknown providers throw.
  let globalSwitch: ReturnType<typeof readGlobalProviderSwitch> | undefined;
  let globalSwitchError: string | undefined;
  try {
    globalSwitch = readGlobalProviderSwitch();
  } catch (err) {
    globalSwitchError = err instanceof Error ? err.message : String(err);
  }
  const globalPinActive = globalSwitch !== undefined;
  return {
    ...observabilityConfigEffectiveFacts(),
    ...practiceConfigEffectiveFacts(),
    ...ingestionConfigEffectiveFacts(),
    ...knowledgeConfigEffectiveFacts(),
    ...copilotConfigEffectiveFacts(),
    ...notesConfigEffectiveFacts(),
    AI_RATE_LIMIT_MAX: { value: rateLimit.max },
    AI_RATE_LIMIT_WINDOW_MS: { value: rateLimit.windowMs },
    CLAUDE_CODE_MAX_RETRIES: { value: piMaxRetries() },
    AI_PROVIDER_ATTEMPT_ADMISSION_MODE: laneResolvedNote(
      'resolveProviderAttemptAdmission（src/server/ai/provider-attempt-admission-config.ts）',
    ),
    AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: laneResolvedNote(
      'resolveProviderAttemptAdmission（src/server/ai/provider-attempt-admission-config.ts）',
    ),
    AI_PROVIDER_SESSION_ADMISSION_MODE: laneResolvedNote(
      'resolveProviderSessionAdmissionPlan（src/server/ai/provider-session-admission.ts）',
    ),
    AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: laneResolvedNote(
      'resolveProviderSessionAdmissionPlan（src/server/ai/provider-session-admission.ts）',
    ),
    'lane.vision_judge.provider': vision.provider,
    'lane.vision_judge.model': vision.model,
    'locale.learner': {
      value: getLearnerLocale(),
      note: 'AI 输出语言：下次 system prompt 构建时读取本进程快照；跨进程轮询间隔 15s（失败保留旧快照），不改变 UI 语言或 typed task',
    },
    MEMORY_RECONCILE_HANDOFF_MODE: handoffMode,
    'lane.global.provider': globalPinActive
      ? { value: globalSwitch?.provider }
      : {
          value: null,
          note: globalSwitchError
            ? `reader throws（fail-visible config error）：${globalSwitchError}`
            : '惰性：无 provider（model-only 配置 runtime 不消费——readGlobalProviderSwitch 的 provider 门），全局 pin 未生效',
        },
    'lane.global.model': globalPinActive
      ? globalSwitch?.model !== undefined
        ? { value: globalSwitch.model }
        : {
            value: null,
            note: 'pin 仅 provider 生效：model 未设置，各 task 走该 provider 的默认 model 解析链',
          }
      : {
          value: null,
          note: globalSwitchError
            ? `reader throws（fail-visible config error）：${globalSwitchError}`
            : '惰性：model-only 配置 runtime 不消费（readGlobalProviderSwitch 的 provider 门）',
        },
  };
}

export function buildAdminConfigRuntimeFacts(): AdminConfigRuntimeFacts {
  const typedBindings = registeredTypedTaskBindings();
  const providers: AdminConfigProviderRow[] = providerAuthSurface().map((row) => ({
    name: row.name,
    auth_mode: row.authMode,
    credential_env: row.credentialEnvName,
    key_present: isProviderLaneReady(row.name),
    implemented: row.implemented,
    implemented_for: {
      chat: row.implemented,
      typed: typedBindings.some((binding) => binding.provider === row.name),
    },
    pi_provider: row.implemented ? piProviderId(row.name) : null,
    models: Object.entries(nativePiModels(row.name)).map(([id, model]) => ({
      id,
      api: model.api,
      input: model.input,
    })),
  }));

  const infraSchedules: AdminConfigScheduleRow[] = [
    {
      ...EVENT_SUBSCRIPTION_DISPATCH_SCHEDULE,
      owner: 'server/event-subscriptions',
      source: 'server-event-subscriptions',
    },
    ...INFRA_HOUSEKEEPING_SCHEDULES.map((decl) => ({
      name: decl.name,
      cron: decl.cron,
      tz: decl.tz,
      owner: 'server/boss',
      queue: decl.queue,
      source: 'server-boss-infra' as const,
      ...(decl.note !== undefined ? { note: decl.note } : {}),
    })),
    ...MEMORY_INFRA_SCHEDULES.map((decl) => ({
      name: decl.name,
      cron: decl.cron,
      tz: decl.tz,
      owner: 'server/memory',
      queue: decl.queue,
      source: 'server-memory-infra' as const,
      ...(decl.note !== undefined ? { note: decl.note } : {}),
    })),
  ];

  // resolveApiPort throws on invalid values (boot-visible); degrade to null so a
  // bad env does not take down the whole read surface.
  let port: number | null;
  try {
    port = resolveApiPort(process.env.API_PORT);
  } catch {
    port = null;
  }

  const effectiveValues = buildEffectiveValues();
  const globalProvider = effectiveValues['lane.global.provider']?.value;
  const globalModel = effectiveValues['lane.global.model']?.value;
  return {
    global_pin:
      typeof globalProvider === 'string'
        ? {
            provider: globalProvider,
            ...(typeof globalModel === 'string' ? { model: globalModel } : {}),
          }
        : null,
    task_bindings: Object.fromEntries(
      Object.keys(tasks).map((kind) => {
        const task = tasks[kind as TaskKind];
        if ('execution' in task && task.execution === 'typed') {
          return [kind, { provider: task.defaultProvider, model: task.defaultModel, error: null }];
        }
        try {
          const binding = resolveTaskProvider(kind as TaskKind);
          // Explicit allowlist: never expose the binding's auth, headers or URLs.
          return [kind, { provider: binding.provider, model: binding.model, error: null }];
        } catch {
          return [
            kind,
            { provider: null, model: null, error: '当前配置不可用，请检查模型目录与服务端凭据。' },
          ];
        }
      }),
    ),
    providers,
    infra_schedules: infraSchedules,
    runtime: {
      port,
      db_pool_max: DB_POOL_MAX,
      queue_tiers: {
        expire_seconds: { fast: EXPIRE_FAST, llm: EXPIRE_LLM, agent: EXPIRE_AGENT },
        retention_seconds: RETENTION_7D,
      },
      orchestration: {
        anchor_cron: ORCHESTRATOR_CRON,
        tz: ORCHESTRATOR_TZ,
        queue: ORCHESTRATOR_QUEUE,
        catchup_window_seconds: ORCHESTRATOR_CATCHUP_WINDOW_SECONDS,
        tick_interval_seconds: TICK_INTERVAL_SECONDS,
        node_timeout_seconds: NODE_TIMEOUT_SECONDS,
        layer_stagger_seconds: LAYER_STAGGER_SECONDS,
        // Orchestrator DAG members have no cron; schedules[] lists only cron rows.
        dag_members: projectDagMembers(capabilities).map((member) => member.name),
      },
    },
    effective_values: effectiveValues,
  };
}
