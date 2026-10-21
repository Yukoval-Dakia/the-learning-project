// Contract history: YUK-1537 added the lead marker; YUK-1547 dropped the
// structured-submit envelope and made @1/@2 verdicts terminal; YUK-1567 retired the
// marked @2→@3 exception, so unresolved sends now use the generic paid-effect void and
// successor authorization (src/db/paid-effect-store.ts). Shared with kernel readers.
export const QUESTION_ADMISSION_CONTRACT_VERSION = 3 as const;
export const QUESTION_ADMISSION_POLICY_ID = 'question_admission@3';
export const QUESTION_ADMISSION_PAID_UNIT = 'admission@3';
export const LEGACY_QUESTION_ADMISSION_POLICY_ID = 'question_admission@1';
export const LEGACY_QUESTION_ADMISSION_PAID_UNIT = 'admission@1';
export const PREVIOUS_QUESTION_ADMISSION_POLICY_ID = 'question_admission@2';
export const PREVIOUS_QUESTION_ADMISSION_PAID_UNIT = 'admission@2';

export const QUESTION_ADMISSION_PAID_UNITS = [
  LEGACY_QUESTION_ADMISSION_PAID_UNIT,
  PREVIOUS_QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNIT,
] as const;

export const QUESTION_ADMISSION_POLICY_IDS = [
  LEGACY_QUESTION_ADMISSION_POLICY_ID,
  PREVIOUS_QUESTION_ADMISSION_POLICY_ID,
  QUESTION_ADMISSION_POLICY_ID,
] as const;
