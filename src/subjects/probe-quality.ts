import type {
  ConjectureHypothesisProposalDraftT,
  ConjectureProbePackageV2T,
  SubjectProbeValidatorResultT,
} from '@/core/schema/business';

export const SUBJECT_PROBE_VALIDATOR_POLICY_VERSION = 'subject-probe-validator-v1' as const;

function normalizeSubjectId(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

export interface SubjectProbeValidatorInput {
  hypothesis: ConjectureHypothesisProposalDraftT;
  package: ConjectureProbePackageV2T;
}

/**
 * A validator owns one narrow, deterministic misconception pattern. It must
 * return not_applicable outside that pattern and fail closed once applicable.
 */
export interface SubjectProbeValidator {
  readonly id: string;
  readonly version: string;
  validate(input: SubjectProbeValidatorInput): SubjectProbeValidatorResultT;
}

const validatorsBySubject = new Map<string, readonly SubjectProbeValidator[]>();

export function registerSubjectProbeValidators(
  subjectId: string,
  validators: readonly SubjectProbeValidator[],
): void {
  const normalizedSubjectId = normalizeSubjectId(subjectId);
  if (normalizedSubjectId.length === 0) {
    throw new Error('subject probe validator registration requires a non-empty subject id');
  }
  if (validatorsBySubject.has(normalizedSubjectId)) {
    throw new Error(`subject probe validators already registered for '${normalizedSubjectId}'`);
  }
  const seenIds = new Set<string>();
  for (const validator of validators) {
    if (validator.id.trim().length === 0 || validator.version.trim().length === 0) {
      throw new Error('subject probe validator id and version must be non-empty');
    }
    if (seenIds.has(validator.id)) {
      throw new Error(`duplicate subject probe validator id '${validator.id}'`);
    }
    seenIds.add(validator.id);
  }
  validatorsBySubject.set(normalizedSubjectId, [...validators]);
}

export function evaluateSubjectProbeValidators(
  subjectId: string,
  input: SubjectProbeValidatorInput,
): SubjectProbeValidatorResultT[] {
  const validators = validatorsBySubject.get(normalizeSubjectId(subjectId)) ?? [];
  return validators.map((validator) => {
    try {
      return validator.validate(input);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : typeof error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        validator_id: validator.id,
        validator_version: validator.version,
        outcome: 'fail',
        failure_codes: ['subject_validator_internal_error'],
        evidence: {
          error_name: errorName.slice(0, 200),
          error_message: errorMessage.slice(0, 4000),
        },
      };
    }
  });
}

export function listSubjectProbeValidators(subjectId: string): readonly SubjectProbeValidator[] {
  return validatorsBySubject.get(normalizeSubjectId(subjectId)) ?? [];
}

export function subjectProbeValidatorResultsEqual(
  left: readonly SubjectProbeValidatorResultT[],
  right: readonly SubjectProbeValidatorResultT[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((result, index) => {
    const candidate = right[index];
    if (
      !candidate ||
      result.validator_id !== candidate.validator_id ||
      result.validator_version !== candidate.validator_version ||
      result.outcome !== candidate.outcome ||
      result.failure_codes.length !== candidate.failure_codes.length ||
      !result.failure_codes.every((code, codeIndex) => code === candidate.failure_codes[codeIndex])
    ) {
      return false;
    }
    const resultEvidenceKeys = Object.keys(result.evidence).sort();
    const candidateEvidenceKeys = Object.keys(candidate.evidence).sort();
    return (
      resultEvidenceKeys.length === candidateEvidenceKeys.length &&
      resultEvidenceKeys.every(
        (key, keyIndex) =>
          key === candidateEvidenceKeys[keyIndex] &&
          result.evidence[key] === candidate.evidence[key],
      )
    );
  });
}
