// YUK-1007 — GET /api/admin/config 运行时事实的组合根装配（server 层）。
//
// 本模块自由 import 一切**真相源**（provider 注册表、boss/memory cron 静态表、
// 运行形态常量、各 capability 经 public 入口透出的 consumer-effective 事实），
// 组装成 AdminConfigRuntimeFacts 由 server/index.ts 在 boot 时经
// observability/public 的 setter 注入（server→public 允许；observability 自身
// 零新边界）。工厂形态：route 每次请求重新调用本函数，providers presence 与
// effective 值跟随 env/热加载 store 保持新鲜（不在 boot 冻结）。
//
// 诚实性：effective 值全部来自真实 reader 调用（不复制规则）；reader 输出非单
// 一标量的键（admission 按 lane、jyeoo backfill 按会话）只给 note；providers[]
// 只带 key presence 布尔与 env 名字，值绝不进 payload。
import { getLearnerLocale } from '@/ai/task-prompts';
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
import type { ConfigEffectiveFact } from '@/core/config/effective';
import { DB_POOL_MAX } from '@/db/pool';
import { projectDagMembers } from '@/kernel/manifest';
import { piMaxRetries } from '@/server/ai/pi-agent-adapter';
import {
  isProviderLaneReady,
  providerAuthSurface,
  readGlobalProviderSwitch,
} from '@/server/ai/providers';
import { visionJudgeProviderOverride } from '@/server/ai/vision-judge-config';
import { INFRA_HOUSEKEEPING_SCHEDULES } from '@/server/boss/handlers';
import { EXPIRE_AGENT, EXPIRE_FAST, EXPIRE_LLM, RETENTION_7D } from '@/server/boss/queue-config';
import { resolveApiPort } from '@/server/env';
import { resolveConfig as resolveAiRateLimitConfig } from '@/server/http/rate-limit';
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

/** 按 lane 解析的 admission 键的统一 note（不伪造单一标量 effective）。 */
function laneResolvedNote(reader: string): ConfigEffectiveFact {
  return {
    note: `按 lane 在读取时解析（${reader}）；无单一标量 effective，读该 reader 的解析结果`,
  };
}

/** 各 capability public 面透出的 consumer-effective 事实 + server 自有键。 */
function buildEffectiveValues(): AdminConfigRuntimeFacts['effective_values'] {
  const rateLimit = resolveAiRateLimitConfig();
  const visionOverride = visionJudgeProviderOverride();
  let handoffMode: ConfigEffectiveFact;
  try {
    handoffMode = { value: memoryReconcileHandoffMode() };
  } catch {
    handoffMode = {
      value: null,
      note: 'reader throws（fail-visible）：非法值在消费点报错，不静默回退',
    };
  }
  // YUK-1007 P1（验证审反例）：lane.global.* 的 effective 必须来自运行时真相源
  // readGlobalProviderSwitch（含 env/DB 合层与 provider 门）——model-only 配置
  // runtime 不消费 ⇒ effective=null；未知 provider 名 ⇒ throw（fail-visible），
  // 如实标注不虚构。
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
    'lane.vision_judge.provider':
      visionOverride === undefined
        ? {
            value: null,
            note: 'override 惰性：未设置，或 OAuth token 缺席/模型无视觉能力被 reader 降级（vision-judge-config.ts）',
          }
        : { value: visionOverride.provider },
    'lane.vision_judge.model':
      visionOverride?.model !== undefined
        ? { value: visionOverride.model }
        : {
            value: null,
            note: '未设置：vision judge 解析链落到 registry 默认（anthropic-sub 自带 claude-opus-4-8 默认）',
          },
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
  const providers: AdminConfigProviderRow[] = providerAuthSurface().map((row) => ({
    name: row.name,
    auth_mode: row.authMode,
    credential_env: row.credentialEnvName,
    key_present: isProviderLaneReady(row.name),
    implemented: row.implemented,
  }));

  const infraSchedules: AdminConfigScheduleRow[] = [
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

  // resolveApiPort 对非法值 throw（boot 同款 fail-visible）；boot 已过的进程
  // 不会到这里，防御性兜 null 不拖死整个读面。
  let port: number | null;
  try {
    port = resolveApiPort(process.env.API_PORT);
  } catch {
    port = null;
  }

  return {
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
        // 编排 DAG 成员（kernel projectDagMembers 同源投影）：无 cron、由
        // orchestrator 从 anchor 触发——schedules[] 只列 cron 行，这里列齐成员名。
        dag_members: projectDagMembers(capabilities).map((member) => member.name),
      },
    },
    effective_values: buildEffectiveValues(),
  };
}
