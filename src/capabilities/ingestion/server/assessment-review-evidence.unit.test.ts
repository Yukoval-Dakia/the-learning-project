import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import { StructuredQuestion } from '@/core/schema/structured_question';
import {
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/kernel/records/assessment-normalization';
import {
  ASSESSMENT_REVIEW_POLICY,
  type AssessmentReviewBindingT,
  assessmentReviewOperationId,
  matchesAssessmentReviewBinding,
  projectAssessmentReviewMedia,
  projectAssessmentReviewQuestion,
  readAssessmentReviewStage,
  readFrozenAssessmentReviewContract,
} from './assessment-review-evidence';

const binding: AssessmentReviewBindingT = {
  session_id: 'session',
  block_id: 'block',
  block_version: 3,
  question_id: 'question',
  question_version: 2,
  group_id: 'question',
  revision_id: 'revision',
  revision_digest: 'digest',
  admission_generation: 1,
  policy_id: ASSESSMENT_REVIEW_POLICY,
};
const evidence = {
  subject_id: 'math',
  verdict: 'pass',
  reason: 'independently agrees',
  compared_by: 'normalize',
  task_runs: [],
};

function jsonbOrder(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(
          ([a], [b]) =>
            Buffer.byteLength(a) - Buffer.byteLength(b) ||
            Buffer.compare(Buffer.from(a), Buffer.from(b)),
        )
        .map(([key, entry]) => [key, jsonbOrder(entry)]),
    );
  return value;
}

describe('assessment review paid-work fence', () => {
  it('preserves the original frozen scoring and private materials across JSONB key order and revision metadata roundtrip', () => {
    for (const structured of [
      null,
      StructuredQuestion.parse({
        id: 'review-part',
        role: 'standalone',
        source: 'vlm_structure',
        prompt_text: 'What is 6 times 7? Explain why addition alone is insufficient.',
        answers: ['42'],
        options: [
          { label: 'A', text: '41' },
          { label: 'B', text: '42' },
        ],
      }),
    ]) {
      const contract = normalizeQuestionRowToContract({
        id: 'review-question',
        kind: structured ? 'choice' : 'calculation',
        prompt_md: 'What is 6 times 7? Explain why addition alone is insufficient.',
        reference_md: structured ? 'B' : '42',
        judge_kind_override: 'exact',
        choices_md: null,
        rubric_json: { private_marking_notes: 'PRIVATE: six groups of seven, not 6 + 7.' },
        structured,
        source: 'vision_paper',
      });
      const persisted = {
        ...contract,
        structure: jsonbOrder(contract.structure),
        response_spec: jsonbOrder(contract.response_spec),
        scoring_basis: jsonbOrder(contract.scoring_basis),
        execution_plan: jsonbOrder(contract.execution_plan),
        revision_id: 'immutable-revision',
        published_at: new Date('2026-10-10T00:00:00Z'),
        supersedes_revision_id: null,
        published_by: undefined,
      };
      expect(contractIntegrityDigest(persisted)).not.toBe(contract.integrity_digest);
      const frozen = readFrozenAssessmentReviewContract(persisted);
      expect(contractIntegrityDigest(frozen)).toBe(contract.integrity_digest);
      expect(frozen.integrity_digest).toBe(persisted.integrity_digest);
      for (const key of ['structure', 'response_spec', 'scoring_basis', 'execution_plan'] as const)
        expect(frozen[key]).toEqual(contract[key]);
      expect(projectAssessmentReviewQuestion(frozen)?.prompt_md).not.toContain('PRIVATE');
      expect(persisted.published_at).toEqual(new Date('2026-10-10T00:00:00Z'));

      const changed = structuredClone(contract);
      changed.structure.parts[0].prompt_md += ' changed';
      expect(() => readFrozenAssessmentReviewContract(changed)).toThrow('integrity mismatch');
      const changedScore = structuredClone(contract);
      changedScore.scoring_basis.units[0].points = 99;
      expect(() => readFrozenAssessmentReviewContract(changedScore)).toThrow('integrity mismatch');
      const stripped = structuredClone(contract);
      Reflect.set(stripped.scoring_basis.units[0], 'unknown_frozen_rule', 'PRIVATE KEY');
      expect(() => readFrozenAssessmentReviewContract(stripped)).toThrow('integrity mismatch');
      const defaulted = structuredClone(contract);
      Reflect.deleteProperty(defaulted.scoring_basis.units[0], 'requires_group_evidence');
      expect(() => readFrozenAssessmentReviewContract(defaulted)).toThrow('integrity mismatch');
    }
  });

  it('compares the printed structured key that will be admitted even when the row has another reference', () => {
    for (const reference of [null, '41']) {
      const contract = normalizeQuestionRowToContract({
        id: 'question',
        kind: 'calculation',
        prompt_md: 'What is 6 times 7?',
        reference_md: reference,
        rubric_json: null,
        choices_md: null,
        judge_kind_override: 'exact',
        structured: StructuredQuestion.parse({
          id: 'part',
          role: 'standalone',
          source: 'vlm_structure',
          prompt_text: 'What is 6 times 7?',
          answers: ['42'],
        }),
      });
      expect(projectAssessmentReviewQuestion(contract)?.reference_md).toBe('42');
      expect(contract.scoring_basis.units[0].criterion).toMatchObject({
        kind: 'text_key',
        accepted_texts: ['42'],
      });
    }
  });

  it('compares frozen option identity and choices rather than a conflicting mutable option key', () => {
    const contract = normalizeQuestionRowToContract({
      id: 'question',
      kind: 'choice',
      prompt_md: 'What is 6 times 7?',
      reference_md: 'A',
      rubric_json: null,
      choices_md: ['unrelated', 'row choices'],
      judge_kind_override: 'exact',
      structured: StructuredQuestion.parse({
        id: 'part',
        role: 'standalone',
        source: 'vlm_structure',
        prompt_text: 'What is 6 times 7?',
        answers: ['B'],
        options: [
          { label: 'A', text: '41' },
          { label: 'B', text: '42' },
        ],
      }),
    });
    expect(projectAssessmentReviewQuestion(contract)).toMatchObject({
      reference_md: 'B',
      choices_md: ['A. 41', 'B. 42'],
    });
  });

  it('deduplicates the same group even when its caller/block identity differs', () => {
    expect(assessmentReviewOperationId({ ...binding, block_id: 'other-block' })).toBe(
      assessmentReviewOperationId(binding),
    );
    expect(assessmentReviewOperationId({ ...binding, admission_generation: 2 })).not.toBe(
      assessmentReviewOperationId(binding),
    );
    expect(assessmentReviewOperationId({ ...binding, revision_id: 'next-revision' })).not.toBe(
      assessmentReviewOperationId(binding),
    );
  });

  it('keeps private scoring text and answer figures out of the blind prompt and media', () => {
    const contract = normalizeQuestionRowToContract({
      id: 'question',
      kind: 'calculation',
      prompt_md: 'What is 6 times 7?',
      reference_md: '42',
      judge_kind_override: 'exact',
      choices_md: null,
      rubric_json: { private_marking_notes: 'SECRET ANSWER WORKING' },
      structured: null,
    });
    const digest = 'a'.repeat(64);
    contract.structure.materials.push(
      {
        material_id: 'prompt',
        kind: 'figure',
        asset: { asset_id: 'diagram', digest: `sha256:${digest}` },
        alt_text: 'figure (diagram)',
      },
      {
        material_id: 'answer',
        kind: 'figure',
        visibility: 'private',
        asset: { asset_id: 'answer-page', digest: `sha256:${digest}` },
        alt_text: 'SECRET ANSWER WORKING',
      },
    );
    contract.structure.parts[0].material_ids.push('prompt', 'answer');
    expect(projectAssessmentReviewQuestion(contract)?.prompt_md).toBe('What is 6 times 7?');
    expect(projectAssessmentReviewMedia(contract.structure)).toEqual({
      figures: [{ asset_id: 'diagram', digest }],
    });
    const promptFigure = contract.structure.materials.find(
      (material) => material.material_id === 'prompt',
    );
    if (!promptFigure) throw new Error('Missing prompt figure fixture');
    promptFigure.alt_text = 'diagram with answers';
    expect(projectAssessmentReviewMedia(contract.structure)).toEqual({
      reason: 'ambiguous_prompt_figure',
    });
  });

  it('refuses a late result after a block, question, revision, digest or admission change', () => {
    for (const changed of [
      { ...binding, block_version: 4 },
      { ...binding, question_version: 3 },
      { ...binding, revision_id: 'next' },
      { ...binding, revision_digest: 'changed' },
      { ...binding, admission_generation: 2 },
    ])
      expect(matchesAssessmentReviewBinding(binding, changed)).toBe(false);
    expect(matchesAssessmentReviewBinding(binding, binding)).toBe(true);
  });

  it('keeps a committed start without a result unknown rather than callable', () => {
    expect(readAssessmentReviewStage([]).state).toBe('not_started');
    expect(
      readAssessmentReviewStage([{ eventType: 'operation.review_started', payload: {} }]).state,
    ).toBe('unknown_result');
  });

  it('reuses the saved parsed result for a local retry', () => {
    expect(
      readAssessmentReviewStage([
        { eventType: 'operation.review_started', payload: {} },
        {
          eventType: 'operation.review_result',
          payload: { evidence, digest: canonicalHash(evidence) },
        },
      ]),
    ).toEqual({ state: 'saved', evidence });
  });

  it('withholds a corrupt saved result without releasing the paid fence', () => {
    for (const payload of [
      { evidence, digest: 'wrong' },
      { evidence: { ...evidence, verdict: 'anything' }, digest: canonicalHash(evidence) },
    ])
      expect(
        readAssessmentReviewStage([{ eventType: 'operation.review_result', payload }]).state,
      ).toBe('unknown_result');
  });
});
