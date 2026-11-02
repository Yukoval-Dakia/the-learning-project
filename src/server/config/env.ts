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
  CONFUSABLE_CONTRAST_ENABLED: optionalString,
  COPILOT_NUDGE_DAILY_MAX: optionalString,
  COPILOT_NUDGE_ENABLED: optionalString,
  COPILOT_NUDGE_EXPIRES_HOURS: optionalString,
  COPILOT_NUDGE_KC_COOLDOWN_HOURS: optionalString,
  COPILOT_NUDGE_STREAK_N: optionalString,
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
  // Tracing controls; the tracing owner still refuses unsupported global-context flags.
  LMNR_DEBUG: optionalString,
  LMNR_DEV_TRANSCRIPTS: optionalString,
  LMNR_PROJECT_API_KEY: optionalString,
  LMNR_SPAN_CONTEXT: optionalString,
  LMNR_TRACE_METADATA: optionalString,
  LOCAL_NEXT_PORT: optionalString,
  LOCAL_POSTGRES_HOST: optionalString,
  LOCAL_POSTGRES_PORT: optionalString,
  LOOM_PG_IMAGE: optionalString,
  MEMORY_RECONCILE_HANDOFF_MODE: optionalString,
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
  MISCONCEPTION_HARD_CONFIRM_ENABLED: optionalString,
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
  QUESTION_SUPPLY_REFILL_ENABLED: optionalString,
  RESEARCH_MEETING_AGENT_ENABLED: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_BUCKET: optionalString,
  R2_ENDPOINT: z.string().url().optional(),
  R2_SECRET_ACCESS_KEY: optionalString,
  // One switch for pg-boss's four automation owners. Disabled is only for isolated
  // restore-acceptance runs; parsing and construction live in resolveBossAutomationMode
  // and src/server/boss/client.ts.
  RW_BOSS_AUTOMATION: z.enum(['enabled', 'disabled']).optional(),
  RW_STATIC_DIR: optionalString,
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
  WAVE6_TRIGGER_VERIFY_ENABLED: optionalString,
  WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: optionalString,
  WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD: optionalString,
  WORKFLOW_JUDGE_OBSERVE_ENABLED: optionalString,
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
