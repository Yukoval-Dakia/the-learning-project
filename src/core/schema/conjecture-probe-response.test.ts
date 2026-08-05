import { describe, expect, it } from 'vitest';
import {
  isCanonicalEvidenceProbeOutcomeResolution,
  isCanonicalProbeOutcomeResolution,
} from './conjecture';
import {
  classifyConjectureProbeResponseFromJudgeMatch,
  isCanonicalProbeOutcomeJudgement,
} from './conjecture-probe-response';

describe('canonical probe outcome/resolution pairs', () => {
  it('accepts only the persisted evidence and inconclusive matrices', () => {
    expect(
      isCanonicalEvidenceProbeOutcomeResolution({ outcome: 0, resolution: 'evidence_for' }),
    ).toBe(true);
    expect(isCanonicalEvidenceProbeOutcomeResolution({ outcome: 0, resolution: 'confirmed' })).toBe(
      true,
    );
    expect(isCanonicalEvidenceProbeOutcomeResolution({ outcome: 1, resolution: 'retired' })).toBe(
      true,
    );
    expect(isCanonicalEvidenceProbeOutcomeResolution({ outcome: 1, resolution: 'confirmed' })).toBe(
      false,
    );
    expect(isCanonicalEvidenceProbeOutcomeResolution({ outcome: 0, resolution: 'retired' })).toBe(
      false,
    );
    expect(
      isCanonicalEvidenceProbeOutcomeResolution({ outcome: null, resolution: 'inconclusive' }),
    ).toBe(false);

    expect(isCanonicalProbeOutcomeResolution({ outcome: null, resolution: 'inconclusive' })).toBe(
      true,
    );
    expect(isCanonicalProbeOutcomeResolution({ outcome: 0, resolution: 'inconclusive' })).toBe(
      false,
    );
    expect(isCanonicalProbeOutcomeResolution({ outcome: null, resolution: 'confirmed' })).toBe(
      false,
    );
  });
});

describe('classifyConjectureProbeResponseFromJudgeMatch', () => {
  it('accepts a gold response only when correctness and the semantic signature agree', () => {
    expect(
      classifyConjectureProbeResponseFromJudgeMatch('correct', {
        match: 'gold',
        explanation_md: 'The response satisfies the declared gold semantics.',
      }),
    ).toMatchObject({
      answer_result: 'correct',
      target_error_match: 'not_matched',
      gradable: true,
      reason_code: 'gold_signature_matched',
    });
  });

  it('accepts target-error evidence only when the correctness verdict and semantic match agree', () => {
    expect(
      classifyConjectureProbeResponseFromJudgeMatch('incorrect', {
        match: 'target_error',
        explanation_md: 'The learner explicitly used addition instead of composing derivatives.',
      }),
    ).toMatchObject({
      answer_result: 'incorrect',
      target_error_match: 'matched',
      gradable: true,
      reason_code: 'target_error_signature_matched',
    });
  });

  it('keeps an ordinary wrong answer separate from the declared target error', () => {
    expect(
      classifyConjectureProbeResponseFromJudgeMatch('incorrect', {
        match: 'neither',
        explanation_md: 'The response is wrong for a different reason.',
      }),
    ).toMatchObject({
      answer_result: 'incorrect',
      target_error_match: 'not_matched',
      gradable: true,
      reason_code: 'response_matches_neither_signature',
    });
  });

  it.each(['partial', 'unsupported'] as const)(
    'fails closed before semantic matching when correctness is %s',
    (coarseOutcome) => {
      expect(
        classifyConjectureProbeResponseFromJudgeMatch(coarseOutcome, {
          match: 'target_error',
          explanation_md: 'The semantic match must not override an ungradable correctness result.',
        }),
      ).toMatchObject({
        answer_result: 'ungradable',
        target_error_match: 'ambiguous',
        gradable: false,
        reason_code: 'correctness_judge_ungradable',
      });
    },
  );

  it('fails closed on an ambiguous, missing, or correctness-conflicting semantic match', () => {
    expect(
      classifyConjectureProbeResponseFromJudgeMatch('incorrect', {
        match: 'ambiguous',
        explanation_md: 'The reason is too short to distinguish the two rules.',
      }),
    ).toMatchObject({
      answer_result: 'ungradable',
      target_error_match: 'ambiguous',
      gradable: false,
      reason_code: 'signature_match_ambiguous',
    });
    expect(classifyConjectureProbeResponseFromJudgeMatch('incorrect', undefined)).toMatchObject({
      answer_result: 'ungradable',
      gradable: false,
      reason_code: 'signature_judgement_missing',
    });
    expect(
      classifyConjectureProbeResponseFromJudgeMatch('correct', {
        match: 'target_error',
        explanation_md: 'The semantic match conflicts with the correctness verdict.',
      }),
    ).toMatchObject({
      answer_result: 'ungradable',
      gradable: false,
      reason_code: 'correctness_signature_conflict',
    });
  });
});

describe('isCanonicalProbeOutcomeJudgement', () => {
  const base = {
    rule_version: 'conjecture_probe_response_signature_v1' as const,
    signature_match_explanation_md: 'Bound semantic comparison.',
    evidence_refs: [
      'learner_response' as const,
      'gold_response_signature' as const,
      'target_error_response_signature' as const,
      'correctness_judge' as const,
    ],
  };

  it('accepts only the canonical gold, target-error, and neither tuples', () => {
    const gold = {
      ...base,
      answer_result: 'correct' as const,
      target_error_match: 'not_matched' as const,
      gradable: true,
      reason_code: 'gold_signature_matched' as const,
    };
    const targetError = {
      ...base,
      answer_result: 'incorrect' as const,
      target_error_match: 'matched' as const,
      gradable: true,
      reason_code: 'target_error_signature_matched' as const,
    };
    const neither = {
      ...base,
      answer_result: 'incorrect' as const,
      target_error_match: 'not_matched' as const,
      gradable: true,
      reason_code: 'response_matches_neither_signature' as const,
    };

    expect(isCanonicalProbeOutcomeJudgement({ outcome: 1, judgement: gold })).toBe(true);
    expect(isCanonicalProbeOutcomeJudgement({ outcome: 0, judgement: targetError })).toBe(true);
    expect(isCanonicalProbeOutcomeJudgement({ outcome: null, judgement: neither })).toBe(true);
    expect(isCanonicalProbeOutcomeJudgement({ outcome: 0, judgement: gold })).toBe(false);
    expect(isCanonicalProbeOutcomeJudgement({ outcome: 1, judgement: targetError })).toBe(false);
    expect(isCanonicalProbeOutcomeJudgement({ outcome: null, judgement: null })).toBe(false);
  });
});
