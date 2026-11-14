import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const optionalString = z.string().optional();

const server = {
  AI_PROVIDER_ATTEMPT_ADMISSION_MODE: optionalString,
  AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: optionalString,
  AI_PROVIDER_MODEL: optionalString,
  AI_PROVIDER_OVERRIDE: optionalString,
  AI_PROVIDER_SESSION_ADMISSION_MODE: optionalString,
  AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: optionalString,
  AI_RATE_LIMIT_MAX: optionalString,
  AI_RATE_LIMIT_WINDOW_MS: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_AUTH_TOKEN: optionalString,
  ANTHROPIC_BASE_URL: optionalString,
  API_PORT: optionalString,
  API_SMOKE_BASE_URL: optionalString,
  AUTO_INTERVENTION_EXPANSION_ENABLED: optionalString,
  // Optional read-only DB URL for report-only audits; falls back to DATABASE_URL and
  // pins the session to read-only either way.
  AUDIT_READ_DATABASE_URL: z.string().url().optional(),
  BACKUP_IMPORT_MAX_BYTES: optionalString,
  BANK_GAP_EVIDENCE_SECRET: optionalString,
  B3_GATE_CONFIRM_CLONE: optionalString,
  // Retry cap honoured by the in-process pi adapter (was the SDK subprocess env).
  CLAUDE_CODE_MAX_RETRIES: optionalString,
  CLAUDE_CODE_OAUTH_TOKEN: optionalString,
  COPILOT_NUDGE_DAILY_MAX: optionalString,
  COPILOT_NUDGE_EXPIRES_HOURS: optionalString,
  COPILOT_SUBAGENT_ENABLED: optionalString,
  DASHSCOPE_API_KEY: optionalString,
  DATABASE_URL: z.string().url(),
  DELIVERY_API_BASE: optionalString,
  DELIVERY_API_PORT: optionalString,
  DOCKER_HOST: optionalString,
  DOCX_CONVERT_ENGINE: optionalString.transform((value) =>
    value === 'docker' ? value : undefined,
  ),
  EXTRACT_OCR_ENGINE: z.enum(['glm', 'tencent']).optional(),
  HOME: optionalString,
  HUB_SYNC_MODE: optionalString,
  INTERNAL_TOKEN: optionalString,
  INTERVENTION_DISABLED_METHOD_IDS: optionalString,
  JUDGE_DURABLE_ENABLED: optionalString,
  JUDGE_CALIBRATION_BATCH_MAX: optionalString,
  JUDGE_CALIBRATION_REJUDGE_MODEL: optionalString,
  JUDGE_CALIBRATION_REJUDGE_PROVIDER: optionalString,
  JUDGE_CALIBRATION_SAMPLING_ENABLED: optionalString,
  JUDGE_CALIBRATION_WINDOW_DAYS: optionalString,
  JUDGE_FALLBACK_PROVIDER: optionalString,
  JUDGE_PROVENANCE_SECRET: optionalString,
  // jyeoo-rs spawn wall clocks: JYEOO_SPAWN_TIMEOUT_MS bounds in-band callers
  // (default 120s; grade routes need ≥ N×90s for N questions), while
  // JYEOO_BACKFILL_TIMEOUT_MS applies only to `pnpm jyeoo:backfill`.
  JYEOO_BACKFILL_TIMEOUT_MS: optionalString,
  JYEOO_DAILY_FETCH_BUDGET: optionalString,
  JYEOO_RS_BINARY: optionalString,
  JYEOO_SPAWN_MAX_STDERR_BYTES: optionalString,
  JYEOO_SPAWN_MAX_STDOUT_BYTES: optionalString,
  JYEOO_SPAWN_TIMEOUT_MS: optionalString,
  KC_DEDUP_DISTANCE_MAX: optionalString,
  KC_DEDUP_MAX_PAIRS: optionalString,
  KC_DEDUP_WINDOW_DAYS: optionalString,
  LEARNING_DAY_INACTIVITY_GAP_HOURS: optionalString,
  // Tracing controls; the tracing owner still refuses unsupported global-context flags.
  LMNR_DEBUG: optionalString,
  LMNR_DEV_TRANSCRIPTS: optionalString,
  LMNR_PROJECT_API_KEY: optionalString,
  LMNR_SPAN_CONTEXT: optionalString,
  LMNR_TRACE_ENV: optionalString,
  LMNR_TRANSCRIPTS: optionalString,
  LMNR_TRACE_METADATA: optionalString,
  LOCAL_NEXT_PORT: optionalString,
  LOCAL_POSTGRES_HOST: optionalString,
  LOCAL_POSTGRES_PORT: optionalString,
  LOOM_PG_IMAGE: optionalString,
  MEM0_EMBEDDING_BASE_URL: optionalString,
  MEM0_EMBEDDING_DIMS: optionalString,
  MEM0_EMBEDDING_MODEL: optionalString,
  MEM0_HISTORY_DB_PATH: optionalString,
  MEM0_LLM_BASE_URL: optionalString,
  MEM0_LLM_MODEL: optionalString,
  MEM0_PGVECTOR_COLLECTION: optionalString,
  MEM0_PGVECTOR_DISKANN: optionalString,
  MEM0_PGVECTOR_HNSW: optionalString,
  MEM0_TELEMETRY: optionalString,
  MIMO_VISION_BASE_URL: optionalString,
  MIMO_VISION_MODEL: optionalString,
  MISCONCEPTION_PROMOTE_ENABLED: optionalString,
  NODE_ENV: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENCODE_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  PATH: optionalString,
  PLACEMENT_PROBE_ENABLED: optionalString,
  POSTGRES_DB: optionalString,
  POSTGRES_PASSWORD: optionalString,
  POSTGRES_USER: optionalString,
  PROFILE_CRITIC_OK: optionalString,
  PROJECTION_IS_WRITER_ITEM_CALIBRATION: optionalString,
  PROPOSAL_AUTO_APPLY_ENABLED: optionalString,
  QUESTION_ADMISSION_POLICY_ID: optionalString,
  QUESTION_ADMISSION_SOLVER2_MODEL: optionalString,
  QUESTION_ADMISSION_SOLVER2_PROVIDER: optionalString,
  QUESTION_SUPPLY_REFILL_ENABLED: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_BUCKET: optionalString,
  R2_ENDPOINT: z.string().url().optional(),
  R2_SECRET_ACCESS_KEY: optionalString,
  // One switch for pg-boss's four automation owners. Disabled is only for isolated
  // restore-acceptance runs; parsing and construction live in resolveBossAutomationMode
  // and src/server/boss/client.ts.
  RW_BOSS_AUTOMATION: z.enum(['enabled', 'disabled']).optional(),
  RW_FRONTDOOR: optionalString,
  RW_WORKER: optionalString,
  SEED_SYNTHETIC_OK: optionalString,
  SELECTION_POLICY: optionalString,
  TAGGING_MATCH_THRESHOLD: optionalString,
  EXA_API_KEY: optionalString,
  TENCENT_OCR_REGION: optionalString,
  TENCENT_SECRET_ID: optionalString,
  TENCENT_SECRET_KEY: optionalString,
  TMPDIR: optionalString,
  TUNNEL_PROTOCOL: optionalString,
  TUNNEL_TOKEN: optionalString,
  VERCEL_AI_GATEWAY_TOKEN: optionalString,
  VERIFY_SOLVE_MODEL_OVERRIDE: optionalString,
  VERIFY_SOLVE_PROVIDER_OVERRIDE: optionalString,
  VISION_JUDGE_MODEL: optionalString,
  VISION_JUDGE_PROVIDER: optionalString,
  VITEST: optionalString,
  WAVE6_TRIGGER_DREAMING_ENABLED: optionalString,
  WAVE6_TRIGGER_MARK_WRONG_ENABLED: optionalString,
  WAVE6_TRIGGER_MASTERY_ENABLED: optionalString,
  WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED: optionalString,
  // Print-page origin for worksheet_render (worker side); production compose sets the
  // app service and local dev defaults to the Vite origin.
  WORKSHEET_RENDER_APP_ORIGIN: z.string().url().optional(),
  XIAOMI_API_KEY: optionalString,
  XIAOMI_TOKEN_PLAN_API_KEY: optionalString,
  XIAOMI_TOKEN_PLAN_BASE_URL: z.string().url().optional(),
  XIAOMI_TOKEN_PLAN_REGION: z.enum(['cn', 'sgp', 'ams']).optional(),
  ZHIPU_API_KEY: optionalString,
  ZAI_CODING_CN_API_KEY: optionalString,
};

/**
 * Where each boot-schema name is allowed to live (config inventory §2). One class per key:
 *   hot    — CONFIG_REGISTRY envName; the DB row wins and env is the fallback/pin layer.
 *   boot   — product code reads the parsed env at start, adapter init, or a job boundary;
 *            there is no DB layer.
 *   secret — credential/HMAC material owned by its entry or adapter; never written to
 *            system_config and never exposed to the browser.
 *   test   — read only by tests, CI, or the local dev wrappers.
 *   script — read only by scripts/CLI/deployment tooling; the API and worker never read it.
 * audit:flags checks this map covers the schema exactly, that `hot` matches the set of
 * registry envNames declared inside the schema, and that no STAY_IN_PLACE_ENV entry is
 * tagged hot. 8 existing registry envNames live outside the schema — they get no owner
 * class here and keep only their getConfig env fallback (audit reports them
 * registry-only): ADMISSION_PROVIDER_RETRY_{BASE_DELAY_MS,MAX_RETRIES,MAX_WAIT_MS},
 * INGESTION_AGENT_WEEKLY_BUDGET_USD, NOTES_MASTERY_SUBSCRIPTION_ENABLED,
 * PROVIDER_STREAM_IDLE_MS, QUESTION_ROOT_PLACEMENT_REFILE_ENABLED,
 * SUPPLY_NIGHTLY_SPEND_CAP_USD.
 */
export type BootEnvOwner = 'boot' | 'secret' | 'test' | 'script' | 'hot';

export const BOOT_ENV_OWNERS = {
  AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'hot',
  AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: 'hot',
  AI_PROVIDER_MODEL: 'hot',
  AI_PROVIDER_OVERRIDE: 'hot',
  AI_PROVIDER_SESSION_ADMISSION_MODE: 'hot',
  AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: 'hot',
  AI_RATE_LIMIT_MAX: 'hot',
  AI_RATE_LIMIT_WINDOW_MS: 'hot',
  ANTHROPIC_API_KEY: 'secret',
  ANTHROPIC_AUTH_TOKEN: 'secret',
  ANTHROPIC_BASE_URL: 'boot',
  API_PORT: 'boot',
  API_SMOKE_BASE_URL: 'script',
  AUTO_INTERVENTION_EXPANSION_ENABLED: 'hot',
  AUDIT_READ_DATABASE_URL: 'script',
  BACKUP_IMPORT_MAX_BYTES: 'hot',
  BANK_GAP_EVIDENCE_SECRET: 'secret',
  B3_GATE_CONFIRM_CLONE: 'script',
  CLAUDE_CODE_MAX_RETRIES: 'hot',
  CLAUDE_CODE_OAUTH_TOKEN: 'secret',
  COPILOT_NUDGE_DAILY_MAX: 'hot',
  COPILOT_NUDGE_EXPIRES_HOURS: 'hot',
  COPILOT_SUBAGENT_ENABLED: 'hot',
  DASHSCOPE_API_KEY: 'secret',
  DATABASE_URL: 'boot',
  DELIVERY_API_BASE: 'script',
  DELIVERY_API_PORT: 'script',
  DOCKER_HOST: 'test',
  DOCX_CONVERT_ENGINE: 'hot',
  EXTRACT_OCR_ENGINE: 'hot',
  HOME: 'script',
  HUB_SYNC_MODE: 'hot',
  INTERNAL_TOKEN: 'secret',
  INTERVENTION_DISABLED_METHOD_IDS: 'hot',
  JUDGE_DURABLE_ENABLED: 'hot',
  JUDGE_CALIBRATION_BATCH_MAX: 'hot',
  JUDGE_CALIBRATION_REJUDGE_MODEL: 'hot',
  JUDGE_CALIBRATION_REJUDGE_PROVIDER: 'hot',
  JUDGE_CALIBRATION_SAMPLING_ENABLED: 'hot',
  JUDGE_CALIBRATION_WINDOW_DAYS: 'hot',
  JUDGE_FALLBACK_PROVIDER: 'hot',
  JUDGE_PROVENANCE_SECRET: 'secret',
  JYEOO_BACKFILL_TIMEOUT_MS: 'hot',
  JYEOO_DAILY_FETCH_BUDGET: 'hot',
  JYEOO_RS_BINARY: 'hot',
  JYEOO_SPAWN_MAX_STDERR_BYTES: 'hot',
  JYEOO_SPAWN_MAX_STDOUT_BYTES: 'hot',
  JYEOO_SPAWN_TIMEOUT_MS: 'hot',
  KC_DEDUP_DISTANCE_MAX: 'hot',
  KC_DEDUP_MAX_PAIRS: 'hot',
  KC_DEDUP_WINDOW_DAYS: 'hot',
  LEARNING_DAY_INACTIVITY_GAP_HOURS: 'hot',
  LMNR_DEBUG: 'boot',
  LMNR_DEV_TRANSCRIPTS: 'boot',
  LMNR_PROJECT_API_KEY: 'secret',
  LMNR_SPAN_CONTEXT: 'boot',
  LMNR_TRACE_ENV: 'boot',
  LMNR_TRANSCRIPTS: 'boot',
  LMNR_TRACE_METADATA: 'boot',
  LOCAL_NEXT_PORT: 'test',
  LOCAL_POSTGRES_HOST: 'test',
  LOCAL_POSTGRES_PORT: 'test',
  LOOM_PG_IMAGE: 'script',
  MEM0_EMBEDDING_BASE_URL: 'boot',
  MEM0_EMBEDDING_DIMS: 'boot',
  MEM0_EMBEDDING_MODEL: 'boot',
  MEM0_HISTORY_DB_PATH: 'boot',
  MEM0_LLM_BASE_URL: 'boot',
  MEM0_LLM_MODEL: 'boot',
  MEM0_PGVECTOR_COLLECTION: 'boot',
  MEM0_PGVECTOR_DISKANN: 'boot',
  MEM0_PGVECTOR_HNSW: 'boot',
  MEM0_TELEMETRY: 'boot',
  MIMO_VISION_BASE_URL: 'script',
  MIMO_VISION_MODEL: 'script',
  MISCONCEPTION_PROMOTE_ENABLED: 'hot',
  NODE_ENV: 'boot',
  OPENAI_API_KEY: 'secret',
  OPENCODE_API_KEY: 'secret',
  OPENROUTER_API_KEY: 'secret',
  PATH: 'script',
  PLACEMENT_PROBE_ENABLED: 'hot',
  POSTGRES_DB: 'script',
  POSTGRES_PASSWORD: 'script',
  POSTGRES_USER: 'script',
  PROFILE_CRITIC_OK: 'script',
  PROJECTION_IS_WRITER_ITEM_CALIBRATION: 'hot',
  PROPOSAL_AUTO_APPLY_ENABLED: 'hot',
  QUESTION_ADMISSION_POLICY_ID: 'hot',
  QUESTION_ADMISSION_SOLVER2_MODEL: 'hot',
  QUESTION_ADMISSION_SOLVER2_PROVIDER: 'hot',
  QUESTION_SUPPLY_REFILL_ENABLED: 'hot',
  R2_ACCESS_KEY_ID: 'secret',
  R2_BUCKET: 'boot',
  R2_ENDPOINT: 'boot',
  R2_SECRET_ACCESS_KEY: 'secret',
  RW_BOSS_AUTOMATION: 'boot',
  RW_FRONTDOOR: 'boot',
  RW_WORKER: 'boot',
  SEED_SYNTHETIC_OK: 'script',
  SELECTION_POLICY: 'hot',
  TAGGING_MATCH_THRESHOLD: 'hot',
  EXA_API_KEY: 'secret',
  TENCENT_OCR_REGION: 'boot',
  TENCENT_SECRET_ID: 'secret',
  TENCENT_SECRET_KEY: 'secret',
  TMPDIR: 'script',
  TUNNEL_PROTOCOL: 'script',
  TUNNEL_TOKEN: 'script',
  VERCEL_AI_GATEWAY_TOKEN: 'secret',
  VERIFY_SOLVE_MODEL_OVERRIDE: 'hot',
  VERIFY_SOLVE_PROVIDER_OVERRIDE: 'hot',
  VISION_JUDGE_MODEL: 'hot',
  VISION_JUDGE_PROVIDER: 'hot',
  VITEST: 'test',
  WAVE6_TRIGGER_DREAMING_ENABLED: 'hot',
  WAVE6_TRIGGER_MARK_WRONG_ENABLED: 'hot',
  WAVE6_TRIGGER_MASTERY_ENABLED: 'hot',
  WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED: 'hot',
  WORKSHEET_RENDER_APP_ORIGIN: 'boot',
  XIAOMI_API_KEY: 'secret',
  XIAOMI_TOKEN_PLAN_API_KEY: 'secret',
  XIAOMI_TOKEN_PLAN_BASE_URL: 'boot',
  XIAOMI_TOKEN_PLAN_REGION: 'boot',
  ZHIPU_API_KEY: 'secret',
  ZAI_CODING_CN_API_KEY: 'secret',
} satisfies Record<keyof typeof server, BootEnvOwner>;

export const SERVER_ENV_KEYS: ReadonlySet<string> = new Set(Object.keys(server));

export function createServerEnv(
  runtimeEnv: Record<string, string | undefined> = process.env,
  skipValidation = Boolean(runtimeEnv.VITEST),
) {
  return createEnv({
    server,
    runtimeEnv,
    skipValidation,
    emptyStringAsUndefined: true,
  });
}

export function getServerEnv(): ReturnType<typeof createServerEnv> {
  return createServerEnv();
}

/**
 * Single parse point for API_PORT (trim → default 8787 → reject non-positive integers),
 * shared by the API entrypoint and the admin config runtime facts.
 */
export function resolveApiPort(rawApiPort: string | undefined): number {
  const trimmed = rawApiPort?.trim();
  const parsed = trimmed ? Number(trimmed) : 8787;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`API_PORT must be a positive integer, got: ${JSON.stringify(rawApiPort)}`);
  }
  return parsed;
}

export type BossAutomationMode = 'enabled' | 'disabled';

/**
 * Single parse point for RW_BOSS_AUTOMATION: unset/empty/'enabled' → 'enabled';
 * 'disabled' turns off pg-boss automation for isolated restore-acceptance runs.
 * Invalid values throw because the VITEST skipValidation path bypasses zod.
 */
export function resolveBossAutomationMode(rawAutomation: string | undefined): BossAutomationMode {
  const trimmed = rawAutomation?.trim();
  if (trimmed === undefined || trimmed === '' || trimmed === 'enabled') return 'enabled';
  if (trimmed === 'disabled') return 'disabled';
  throw new Error(
    `RW_BOSS_AUTOMATION must be 'enabled' or 'disabled', got: ${JSON.stringify(rawAutomation)}`,
  );
}

export function requireApiInternalToken(
  runtimeEnv: Record<string, string | undefined> = process.env,
): string {
  return z
    .string({ error: 'INTERNAL_TOKEN is required for the API' })
    .min(1, 'INTERNAL_TOKEN is required for the API')
    .parse(runtimeEnv.INTERNAL_TOKEN);
}
