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
  BACKUP_IMPORT_MAX_BYTES: optionalString,
  CLAUDE_CODE_OAUTH_TOKEN: optionalString,
  CONFUSABLE_CONTRAST_ENABLED: optionalString,
  DASHSCOPE_API_KEY: optionalString,
  DATABASE_URL: z.string().url(),
  DOCX_CONVERT_ENGINE: z.enum(['docker']).optional(),
  EXTRACT_OCR_ENGINE: z.enum(['glm', 'tencent']).optional(),
  HUB_SYNC_MODE: optionalString,
  INTERNAL_TOKEN: z.string().min(1),
  JUDGE_DURABLE_ENABLED: optionalString,
  JUDGE_FALLBACK_PROVIDER: optionalString,
  JUDGE_PROVENANCE_SECRET: optionalString,
  JYEOO_FETCH_ENABLED: optionalString,
  JYEOO_RS_BINARY: optionalString,
  KC_DEDUP_DISTANCE_MAX: optionalString,
  KC_DEDUP_MAX_PAIRS: optionalString,
  KC_DEDUP_WINDOW_DAYS: optionalString,
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
  PLACEMENT_PROBE_ENABLED: optionalString,
  PROJECTION_IS_WRITER: optionalString,
  QUESTION_SUPPLY_REFILL_ENABLED: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_BUCKET: optionalString,
  R2_ENDPOINT: z.string().url().optional(),
  R2_SECRET_ACCESS_KEY: optionalString,
  RW_STATIC_DIR: optionalString,
  RW_WORKER: optionalString,
  SELECTION_POLICY: optionalString,
  SKIP_BOSS_INGEST: optionalString,
  TAGGING_MATCH_THRESHOLD: optionalString,
  TAVILY_API_KEY: optionalString,
  TENCENT_OCR_REGION: optionalString,
  TENCENT_SECRET_ID: optionalString,
  TENCENT_SECRET_KEY: optionalString,
  VISION_JUDGE_PROVIDER: optionalString,
  VITEST: optionalString,
  WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: optionalString,
  WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD: optionalString,
  WORKFLOW_JUDGE_OBSERVE_ENABLED: optionalString,
  WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED: optionalString,
  XIAOMI_API_KEY: optionalString,
  ZHIPU_API_KEY: optionalString,
};

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

let cachedEnv: ReturnType<typeof createServerEnv> | undefined;

export function getServerEnv(): ReturnType<typeof createServerEnv> {
  cachedEnv ??= createServerEnv();
  return cachedEnv;
}
