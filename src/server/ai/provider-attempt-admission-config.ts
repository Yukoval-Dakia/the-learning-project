import { z } from 'zod';
import { type ConfigValue, getConfig } from '@/core/config/store';

export const PROVIDER_ATTEMPT_ADMISSION_LANES = [
  'dashscope.embedding',
  'glm.knowledge-edge-reconcile',
  'glm.memory-reconcile',
  'glm.ocr-layout-parsing',
  'mem0.event-memory',
  'tencent.question-mark-agent',
] as const;

export type ProviderAttemptAdmissionLane = (typeof PROVIDER_ATTEMPT_ADMISSION_LANES)[number];
export type ProviderAttemptAdmissionMode = 'off' | 'observe' | 'enforce';

export type ProviderAttemptAdmissionPolicy = {
  readonly maxConcurrentAttempts: number;
  readonly maxAttemptStartsPerMinute: number;
};

export type ResolvedProviderAttemptAdmission = {
  readonly mode: ProviderAttemptAdmissionMode;
  readonly policy: ProviderAttemptAdmissionPolicy | null;
};

const ModeSchema = z.enum(['off', 'observe', 'enforce']);
export const ProviderAttemptAdmissionLaneSchema = z.enum(PROVIDER_ATTEMPT_ADMISSION_LANES);
const PolicySchema = z
  .object({
    maxConcurrentAttempts: z.number().int().positive(),
    maxAttemptStartsPerMinute: z.number().int().positive(),
  })
  .strict();
const PoliciesSchema = z
  .object({
    'dashscope.embedding': PolicySchema.optional(),
    'glm.knowledge-edge-reconcile': PolicySchema.optional(),
    'glm.memory-reconcile': PolicySchema.optional(),
    'glm.ocr-layout-parsing': PolicySchema.optional(),
    'mem0.event-memory': PolicySchema.optional(),
    'tencent.question-mark-agent': PolicySchema.optional(),
  })
  .strict();

/**
 * 配置来源分层（YUK-1007）：DB 行 > env > 'off'。env 层是 JSON 原文字符串；
 * DB 层存的是解析后的对象（registry schema 拦形状、write.ts 拦 lane 名）。
 * 非法值（错 mode 字符串 / 坏 JSON / 未知 lane）**照旧 throw**——admission
 * 是断流面，fail-open 回归禁装（registry envParse 原文透传就是为保这个）。
 */
function policiesInput(raw: ConfigValue | string | undefined): unknown {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    return JSON.parse(trimmed); // 原语义：JSON.parse throw 直通
  }
  return raw; // DB 层来的对象直过
}

export function resolveProviderAttemptAdmission(
  env: NodeJS.ProcessEnv,
  lane: ProviderAttemptAdmissionLane,
): ResolvedProviderAttemptAdmission {
  // env 形参保签名：作 env fallback 层传给 getConfig（DB 行在场时 DB 恒赢）。
  const rawMode = getConfig('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', env);
  const mode = rawMode === undefined || rawMode === '' ? 'off' : ModeSchema.parse(rawMode);
  if (mode === 'off') return { mode: 'off', policy: null };
  const parsed = policiesInput(getConfig('AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON', env));
  if (parsed === undefined) return { mode: 'off', policy: null };
  const policies = PoliciesSchema.parse(parsed);
  const policy = policies[lane];
  if (policy === undefined) return { mode: 'off', policy: null };
  return { mode, policy };
}
