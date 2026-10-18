// YUK-1537: a changed solve contract authorizes a NEW claim, never replay of an unknown.
// Shared with kernel serving readers; no capability/runtime dependencies.
export const QUESTION_ADMISSION_CONTRACT_VERSION = 2 as const;
export const QUESTION_ADMISSION_POLICY_ID = 'question_admission@2';
export const QUESTION_ADMISSION_PAID_UNIT = 'admission@2';
export const LEGACY_QUESTION_ADMISSION_POLICY_ID = 'question_admission@1';
export const LEGACY_QUESTION_ADMISSION_PAID_UNIT = 'admission@1';
