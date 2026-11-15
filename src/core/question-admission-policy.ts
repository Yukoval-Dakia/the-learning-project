// Contract versions fence paid identities; historical verdicts and obligations remain authoritative.
export const QUESTION_ADMISSION_CONTRACT_VERSION = 5 as const;
export const QUESTION_ADMISSION_POLICY_ID = 'question_admission@5';
export const QUESTION_ADMISSION_PAID_UNIT = 'admission@5';
export const LEGACY_QUESTION_ADMISSION_POLICY_ID = 'question_admission@1';
export const LEGACY_QUESTION_ADMISSION_PAID_UNIT = 'admission@1';
export const PREVIOUS_QUESTION_ADMISSION_POLICY_ID = 'question_admission@2';
export const PREVIOUS_QUESTION_ADMISSION_PAID_UNIT = 'admission@2';
/** Two blind solves per question; superseded by one blind solve plus adjudication. */
export const DUAL_SOLVE_QUESTION_ADMISSION_POLICY_ID = 'question_admission@4';
export const DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT = 'admission@4';

export const QUESTION_ADMISSION_PAID_UNITS = [
  LEGACY_QUESTION_ADMISSION_PAID_UNIT,
  PREVIOUS_QUESTION_ADMISSION_PAID_UNIT,
  'admission@3',
  DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNIT,
] as const;

export const QUESTION_ADMISSION_POLICY_IDS = [
  LEGACY_QUESTION_ADMISSION_POLICY_ID,
  PREVIOUS_QUESTION_ADMISSION_POLICY_ID,
  'question_admission@3',
  DUAL_SOLVE_QUESTION_ADMISSION_POLICY_ID,
  QUESTION_ADMISSION_POLICY_ID,
] as const;

export const STRUCTURED_QUESTION_ADMISSION_PAID_UNIT = 'admission@3';
