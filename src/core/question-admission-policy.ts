// YUK-1537: changed contract; unknown upgrades additionally require the lead marker.
// YUK-1547: the structured-submit transport dropped its `{result: ...}` envelope —
// new contract `question_admission@3` / `admission@3`; applied @1/@2 verdicts stay
// terminal except the one lead-marked @2 kind-mismatch solve_conflict reopen.
// Shared with kernel serving readers; no capability/runtime dependencies.
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

/**
 * Lead-only marker carried on a job's `reopen_paid_effect_identity`: the exact
 * old paid-effect row identity (unit + input digest) the marked @3 send re-opens.
 */
export interface AdmissionReopenMarker {
  readonly unit: string;
  readonly inputDigest: string;
}
