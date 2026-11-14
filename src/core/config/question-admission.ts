import { canonicalProviderName } from '@/ai/task-spec';
import {
  LEGACY_QUESTION_ADMISSION_POLICY_ID,
  PREVIOUS_QUESTION_ADMISSION_POLICY_ID,
  QUESTION_ADMISSION_POLICY_ID,
} from '@/core/question-admission-policy';
import { getConfigMany, getConfigSnapshotEpoch, resolveKeyDef } from './store';

export const QUESTION_ADMISSION_CONFIG_KEYS = [
  'QUESTION_ADMISSION_POLICY_ID',
  'QUESTION_ADMISSION_SOLVER2_PROVIDER',
  'QUESTION_ADMISSION_SOLVER2_MODEL',
] as const;

const OBSOLETE_QUESTION_ADMISSION_POLICY_IDS = new Set([
  LEGACY_QUESTION_ADMISSION_POLICY_ID,
  PREVIOUS_QUESTION_ADMISSION_POLICY_ID,
  'question_admission@3',
]);

export interface QuestionAdmissionSolver2Override {
  readonly provider?: string;
  readonly model?: string;
}

export interface QuestionAdmissionConfig {
  readonly policyId: string;
  readonly solver2: QuestionAdmissionSolver2Override | null;
}

/**
 * Resolve the admission policy and solver override from one config snapshot.
 * Solver B keeps the existing per-field override semantics: either field may be
 * absent, while task binding still rejects a combination it cannot execute.
 */
export function readQuestionAdmissionConfig(): QuestionAdmissionConfig {
  const epochBefore = getConfigSnapshotEpoch();
  const values = getConfigMany(QUESTION_ADMISSION_CONFIG_KEYS);
  const epochAfter = getConfigSnapshotEpoch();
  if (epochBefore !== epochAfter) {
    throw new Error('question admission config changed while resolving one snapshot');
  }

  for (const key of QUESTION_ADMISSION_CONFIG_KEYS) {
    const value = values[key];
    if (value === undefined && key !== 'QUESTION_ADMISSION_POLICY_ID') continue;
    const parsed = resolveKeyDef(key)?.schema.safeParse(value);
    if (!parsed?.success) {
      throw new Error(`invalid question admission config value for ${key}`);
    }
  }

  const policyValue = values.QUESTION_ADMISSION_POLICY_ID;
  const policyId = typeof policyValue === 'string' ? policyValue : QUESTION_ADMISSION_POLICY_ID;
  if (OBSOLETE_QUESTION_ADMISSION_POLICY_IDS.has(policyId)) {
    throw new Error(
      `QUESTION_ADMISSION_POLICY_ID=${policyId} is obsolete; unset it for the current admission contract`,
    );
  }

  const rawProvider = values.QUESTION_ADMISSION_SOLVER2_PROVIDER;
  const modelValue = values.QUESTION_ADMISSION_SOLVER2_MODEL;
  const model = typeof modelValue === 'string' ? modelValue : undefined;
  const provider = typeof rawProvider === 'string' ? canonicalProviderName(rawProvider) : undefined;
  const solver2 =
    provider === undefined && model === undefined
      ? null
      : Object.freeze({
          ...(provider === undefined ? {} : { provider }),
          ...(model === undefined ? {} : { model }),
        });

  return Object.freeze({ policyId, solver2 });
}
