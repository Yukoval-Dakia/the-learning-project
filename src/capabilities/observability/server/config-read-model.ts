// YUK-1007 — 配置读模型（GET /api/admin/config 的装配层）。
//
// 设计输入：docs/design/2026-09-26-yuk1007-settings-panel-preflight.md §10.1/§10.2
// （读面契约）+ PR #1498 已落地的热加载 store（src/core/config）。本文件只做
// **装配与分类**，不做任何解析决策——分层（env pin > DB > env fallback > code
// default / compose-forced 跳 DB）全部复用 store 的 resolveConfigValue，单一真相
// 源不在此重复；effective 值与 providers/schedules/runtime 分区 likewise 来自
// 组合根注入的真实事实（admin-config-facts.ts，调用真实 reader/注册表，本层
// 零规则复制）。输出直接是 wire 形状（api/admin-config-contracts.ts 的
// AdminConfigResponseSchema 与之 1:1，由单测 safeParse 钉住等价）。
//
// 诚实性规则（本端点存在的理由）：
//   - keys[] 只枚举 registry **已登记**的 key——不枚举 process.env，不 dump
//     未分类值；secret 按 grounding §1.5「不建 key」清单天然不在面上。
//   - 每个 key 带 wired/consumer：wired=false 表示「DB/env 值当前没有运行时
//     reader 消费」（未接线）。未列入 KEY_CONSUMERS 的 key 一律按未接线报——
//     新增 registry key 而忘登记时，读面**低估**生效面，不会虚报。
//   - tasks[] 不把静态 TaskSpec 默认说成运行时覆盖：default 永远标注为 catalog
//     冻结值；override 单列，且逐字段标注 override_wired（budget 尚未接线——
//     runner 只认 ctx.budgetOverride 参数，DB budget 行存而不读）。
//   - 不在此重算 resolveTaskProvider 的合成结果（arg > env pin > DB > registry
//     链的单一真相源在 src/server/ai/providers.ts）——读面给出分层事实
//     （default / override / global_pin），合成留给消费方。
//
// 纯同步、零 DB：route 调用点在快照之上，hydrate 由 boot/refresh 周期负责。

import { tasks } from '@/ai/registry';
import { capabilities } from '@/capabilities';
import type { ConfigSource, ConfigValue } from '@/core/config/store';
import {
  CONFIG_REGISTRY,
  getConfigSnapshot,
  getLaneOverride,
  getTaskOverride,
  resolveConfigValue,
} from '@/core/config/store';

import type {
  AdminConfigProviderRow,
  AdminConfigRuntimeFacts,
  AdminConfigRuntimeSection,
  AdminConfigScheduleRow,
} from './admin-config-facts';

/** 读面值的 JSON 形状（ConfigValue 去 undefined；非有限数在装配层归 null）。 */
export type AdminConfigValue = ConfigValue | null;

/**
 * registry key → 运行时消费方声明（wired 证据）。value = 消费 reader 的文件
 * 路径；null = 已登记但 reader 未接线。
 *
 * 完整性由 config-read-model.unit.test.ts 钉死：CONFIG_REGISTRY 每键必须在此
 * 分类，防新增 key 漏分类；分类错误（标 wired 但 reader 实际未读）属于
 * KEY_CONSUMERS 维护 bug，走常规 review 修正。
 */
export const KEY_CONSUMERS: Readonly<Record<string, string | null>> = {
  JUDGE_DURABLE_ENABLED: 'src/capabilities/practice/server/judge-durable-config.ts',
  JUDGE_FALLBACK_PROVIDER: 'src/capabilities/practice/server/judge-durable-config.ts',
  MISCONCEPTION_PROMOTE_ENABLED: 'src/capabilities/agency/server/misconception-promote.ts',
  MISCONCEPTION_HARD_CONFIRM_ENABLED: 'src/capabilities/agency/server/misconception-promote.ts',
  QUESTION_SUPPLY_REFILL_ENABLED: 'src/capabilities/practice/server/question-supply/refill.ts',
  CONFUSABLE_CONTRAST_ENABLED:
    'src/capabilities/practice/server/question-supply/confusable-contrast-discovery.ts',
  RESEARCH_MEETING_AGENT_ENABLED: 'src/capabilities/agency/jobs/research_meeting_agent_nightly.ts',
  JUDGE_CALIBRATION_SAMPLING_ENABLED: 'src/capabilities/practice/jobs/judge_calibration_sample.ts',
  WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: 'src/capabilities/ingestion/server/workflow-judge-config.ts',
  WORKFLOW_JUDGE_OBSERVE_ENABLED: 'src/capabilities/ingestion/server/workflow-judge-config.ts',
  WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD:
    'src/capabilities/ingestion/server/workflow-judge-config.ts',
  WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED:
    'src/capabilities/ingestion/server/workflow-judge-config.ts',
  WAVE6_TRIGGER_MARK_WRONG_ENABLED: 'src/capabilities/notes/server/note-refine-triggers.ts',
  WAVE6_TRIGGER_MASTERY_ENABLED: 'src/capabilities/notes/server/note-refine-triggers.ts',
  WAVE6_TRIGGER_DREAMING_ENABLED: 'src/capabilities/notes/server/note-refine-triggers.ts',
  WAVE6_TRIGGER_VERIFY_ENABLED: 'src/capabilities/notes/server/note-refine-triggers.ts',
  NOTES_MASTERY_SUBSCRIPTION_ENABLED:
    'src/capabilities/notes/server/mastery-progress-subscription.ts',
  AUTO_INTERVENTION_EXPANSION_ENABLED: 'src/capabilities/agency/server/intervention/snapshot.ts',
  INTERVENTION_DISABLED_METHOD_IDS: 'src/capabilities/agency/server/intervention/snapshot.ts',
  COPILOT_SUBAGENT_ENABLED: 'src/capabilities/copilot/server/subagents.ts',
  COPILOT_NUDGE_ENABLED: 'src/capabilities/copilot/server/nudge-config.ts',
  COPILOT_NUDGE_DAILY_MAX: 'src/capabilities/copilot/server/nudge-config.ts',
  COPILOT_NUDGE_EXPIRES_HOURS: 'src/capabilities/copilot/server/nudge-config.ts',
  COPILOT_NUDGE_STREAK_N: 'src/capabilities/copilot/server/nudge-config.ts',
  COPILOT_NUDGE_KC_COOLDOWN_HOURS: 'src/capabilities/copilot/server/nudge-config.ts',
  SELECTION_POLICY: 'src/capabilities/practice/server/stream-store.ts',
  HUB_SYNC_MODE: 'src/capabilities/notes/server/hub-sync-reconciliation.ts',
  MEMORY_RECONCILE_HANDOFF_MODE: 'src/server/memory/memory-reconcile-handoff.ts',
  PROJECTION_IS_WRITER_ITEM_CALIBRATION: 'src/server/projections/sot-flag.ts',
  PLACEMENT_PROBE_ENABLED: 'src/server/session/placement.ts',
  AI_RATE_LIMIT_MAX: 'src/server/http/rate-limit.ts',
  AI_RATE_LIMIT_WINDOW_MS: 'src/server/http/rate-limit.ts',
  CLAUDE_CODE_MAX_RETRIES: 'src/server/ai/pi-agent-adapter.ts',
  JUDGE_CALIBRATION_BATCH_MAX: 'src/capabilities/practice/jobs/judge-calibration-config.ts',
  JUDGE_CALIBRATION_WINDOW_DAYS: 'src/capabilities/practice/jobs/judge-calibration-config.ts',
  JUDGE_CALIBRATION_REJUDGE_PROVIDER: 'src/capabilities/practice/jobs/judge-calibration-config.ts',
  JUDGE_CALIBRATION_REJUDGE_MODEL: 'src/capabilities/practice/jobs/judge-calibration-config.ts',
  JYEOO_RS_BINARY: 'src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts',
  JYEOO_SPAWN_TIMEOUT_MS: 'src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts',
  JYEOO_BACKFILL_TIMEOUT_MS:
    'src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts',
  JYEOO_SPAWN_MAX_STDOUT_BYTES:
    'src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts',
  JYEOO_SPAWN_MAX_STDERR_BYTES:
    'src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts',
  JYEOO_DAILY_FETCH_BUDGET: 'src/capabilities/practice/server/question-supply/jyeoo-budget.ts',
  EXTRACT_OCR_ENGINE: 'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts',
  DOCX_CONVERT_ENGINE: 'src/capabilities/ingestion/server/docx/convert.ts',
  KC_DEDUP_DISTANCE_MAX: 'src/capabilities/knowledge/server/dedup-flags.ts',
  KC_DEDUP_WINDOW_DAYS: 'src/capabilities/knowledge/server/dedup-flags.ts',
  KC_DEDUP_MAX_PAIRS: 'src/capabilities/knowledge/server/dedup-flags.ts',
  TAGGING_MATCH_THRESHOLD: 'src/capabilities/knowledge/server/tagging-flags.ts',
  BACKUP_IMPORT_MAX_BYTES: 'src/capabilities/observability/api/backup-import.ts',
  AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'src/server/ai/provider-attempt-admission-config.ts',
  AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: 'src/server/ai/provider-attempt-admission-config.ts',
  AI_PROVIDER_SESSION_ADMISSION_MODE: 'src/server/ai/provider-session-admission.ts',
  AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: 'src/server/ai/provider-session-admission.ts',
  'lane.verify_solve.provider': 'src/capabilities/practice/server/quiz/solve-lane.ts',
  'lane.verify_solve.model': 'src/capabilities/practice/server/quiz/solve-lane.ts',
  'lane.vision_judge.provider': 'src/server/ai/vision-judge-config.ts',
  'lane.vision_judge.model': 'src/server/ai/vision-judge-config.ts',
  'lane.global.provider': 'src/server/ai/providers.ts',
  'lane.global.model': 'src/server/ai/providers.ts',
  'locale.learner': 'src/ai/task-prompts.ts',
};

/** task.<kind>.* 覆盖字段的接线状态（runner budget seam 未迁移前 budget 不生效）。 */
export const TASK_OVERRIDE_WIRING = {
  provider: true,
  model: true,
  budget: false,
} as const;

/** wire 形状（与 AdminConfigResponseSchema 1:1；契约测试钉等价）。 */
export interface AdminConfigKeyRow {
  readonly key: string;
  readonly value: AdminConfigValue;
  readonly source: ConfigSource;
  readonly default: AdminConfigValue;
  /** consumer 实际消费的值（真实 reader 调用产出，经 facts seam 注入）；
   * 缺席 = consumer 直通（configured 即生效）。区分 configured(value) 与
   * effective 是诚实性要求：reader 有 clamp/floor/降级时两者会分叉。 */
  readonly effective?: AdminConfigValue;
  readonly effective_note?: string;
  readonly env_name: string | null;
  readonly env_mode: 'fallback' | 'priority' | 'pinned';
  readonly tier: 'A' | 'B' | 'C';
  readonly read_only: boolean;
  readonly wired: boolean;
  readonly consumer: string | null;
  readonly revision: number | null;
  readonly updated_at: string | null;
  readonly note?: string;
}

export interface AdminConfigTaskRow {
  readonly kind: string;
  readonly default_provider: string;
  readonly default_model: string;
  readonly default_budget: {
    readonly maxIterations: number;
    readonly maxCost: number;
    readonly transientRetries: number;
    readonly timeout: number;
  };
  readonly override: { provider?: string; model?: string; budget?: Record<string, unknown> } | null;
  readonly override_wired: {
    readonly provider: boolean;
    readonly model: boolean;
    readonly budget: boolean;
  };
  readonly global_pin: { provider?: string; model?: string } | null;
}

export interface AdminConfigReadModel {
  readonly snapshot: {
    readonly epoch: number;
    readonly hydrated_at: string | null;
  };
  /** 运行时事实（providers[]/infra schedules/runtime/effective）是否已由组合根
   * 注入；false 时对应分区如实置空，不伪造。 */
  readonly facts_injected: boolean;
  readonly keys: readonly AdminConfigKeyRow[];
  readonly tasks: readonly AdminConfigTaskRow[];
  readonly providers: readonly AdminConfigProviderRow[];
  readonly schedules: {
    readonly read_only_note: string;
    readonly rows: readonly AdminConfigScheduleRow[];
  };
  readonly runtime: AdminConfigRuntimeSection | null;
}

/** ConfigValue → JSON 值：undefined 与非有限数（NaN env 字面量）归 null。 */
function normalizeValue(value: ConfigValue | null | undefined): AdminConfigValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/**
 * 全局 pin 的**caller 语义**合成（不是逐字段合成）：
 * `readGlobalProviderSwitch`（src/server/ai/providers.ts，运行时唯一真相源）
 * 在 env provider pin 在场时整体返回 env 对（all-or-nothing），不再下探 DB
 * model；env 缺席时才用 DB 对，且 DB 支路以 **provider 在场为门**
 * （providers.ts `if (!db?.provider) return undefined`）——只有
 * lane.global.model 而无 lane.global.provider 的行在运行时**不消费**（惰性）。
 * 此处镜像这两道门，避免读面虚报 runtime 不消费的 DB 值（「实际 caller
 * 生效语义 > 表面 DB 值」）。单测用真实 resolver（hasGlobalProviderOverride /
 * resolveTaskProvider）对照钉住一致性。
 */
function resolveGlobalPin(env: NodeJS.ProcessEnv): { provider?: string; model?: string } | null {
  const provider = resolveConfigValue('lane.global.provider', env);
  if (provider.source === 'env') {
    const model = resolveConfigValue('lane.global.model', env);
    return {
      provider: provider.value as string,
      ...(model.source === 'env' && typeof model.value === 'string' ? { model: model.value } : {}),
    };
  }
  // Caller gate（providers.ts readGlobalProviderSwitch）：model-only DB 行惰性。
  const lanePair = getLaneOverride('global', env);
  return lanePair?.provider !== undefined ? lanePair : null;
}

/**
 * capability manifest 声明的 cron 投影（真实声明源：capabilities[] 的
 * jobs.handlers[].schedule；不手工复制清单）。编排 DAG 成员（dependsOn 存在）
 * 无 cron——由 orchestrator 触发，成员名单见 runtime.orchestration.dag_members。
 */
function manifestScheduleRows(): AdminConfigScheduleRow[] {
  return capabilities
    .flatMap((cap) => (cap.jobs?.handlers ?? []).map((job) => ({ cap, job })))
    .filter(({ job }) => job.schedule !== undefined)
    .map(({ cap, job }) => ({
      name: job.name,
      cron: job.schedule?.cron ?? '',
      tz: job.schedule?.tz ?? '',
      owner: cap.name,
      queue: job.queue,
      source: 'capability-manifest' as const,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const SCHEDULES_READ_ONLY_NOTE =
  '只读静态投影：cron 的改动是代码改动（capability manifest 声明 / server 注册表），不是热加载配置写；本端点不触发任何 worker 行为。编排 DAG 成员无 cron（由 orchestrator 从 anchor 触发），名单见 runtime.orchestration.dag_members。';

/**
 * 装配读面。`env` 是注入 seam（默认 process.env）——只读 registry 登记过的
 * env 名，从不枚举整个 env。`facts` 是组合根注入的运行时事实
 * （getAdminConfigRuntimeFacts()；null = 未注入，分区如实置空）。
 */
export function buildAdminConfigReadModel(
  env: NodeJS.ProcessEnv = process.env,
  facts: AdminConfigRuntimeFacts | null = null,
): AdminConfigReadModel {
  const snap = getConfigSnapshot();

  const keyRows: AdminConfigKeyRow[] = Object.keys(CONFIG_REGISTRY)
    .sort()
    .map((key) => {
      const def = CONFIG_REGISTRY[key];
      const resolved = resolveConfigValue(key, env);
      const consumer = KEY_CONSUMERS[key] ?? null;
      const envMode = def.envMode ?? 'fallback';
      const effectiveFact = facts?.effective_values[key];
      return {
        key,
        value: normalizeValue(resolved.value),
        source: resolved.source,
        default: normalizeValue(def.codeDefault),
        ...(effectiveFact !== undefined && effectiveFact.value !== undefined
          ? { effective: normalizeValue(effectiveFact.value) }
          : {}),
        ...(effectiveFact?.note !== undefined ? { effective_note: effectiveFact.note } : {}),
        env_name: def.envName ?? null,
        env_mode: envMode,
        tier: def.tier,
        read_only: envMode === 'pinned',
        wired: consumer !== null,
        consumer,
        revision:
          resolved.source === 'db' && resolved.revision !== undefined ? resolved.revision : null,
        updated_at:
          resolved.source === 'db' &&
          resolved.updatedAt !== undefined &&
          resolved.updatedAt !== null
            ? resolved.updatedAt
            : null,
        ...(def.note !== undefined ? { note: def.note } : {}),
      };
    });

  const globalPin = resolveGlobalPin(env);
  const taskRows: AdminConfigTaskRow[] = Object.entries(tasks).map(([kind, def]) => {
    const override = getTaskOverride(kind);
    const typed = 'execution' in def && def.execution === 'typed';
    return {
      kind,
      default_provider: def.defaultProvider,
      default_model: def.defaultModel,
      default_budget: def.budget,
      override: override
        ? {
            ...(override.provider !== undefined ? { provider: override.provider } : {}),
            ...(override.model !== undefined ? { model: override.model } : {}),
            ...(override.budget !== undefined
              ? { budget: override.budget as Record<string, unknown> }
              : {}),
          }
        : null,
      override_wired: typed
        ? { provider: false, model: false, budget: false }
        : { ...TASK_OVERRIDE_WIRING },
      global_pin: typed ? null : globalPin,
    };
  });

  const infraRows = facts?.infra_schedules ?? [];
  return {
    snapshot: { epoch: snap.epoch, hydrated_at: snap.hydratedAt === '' ? null : snap.hydratedAt },
    facts_injected: facts !== null,
    keys: keyRows,
    tasks: taskRows,
    providers: [...(facts?.providers ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    schedules: {
      read_only_note: SCHEDULES_READ_ONLY_NOTE,
      rows: [
        ...manifestScheduleRows(),
        ...[...infraRows].sort((left, right) => left.name.localeCompare(right.name)),
      ],
    },
    runtime: facts?.runtime ?? null,
  };
}
