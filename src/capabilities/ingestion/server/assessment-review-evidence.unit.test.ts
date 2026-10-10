import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import { StructuredQuestion } from '@/core/schema/structured_question';
import { normalizeQuestionRowToContract } from '@/kernel/records/assessment-normalization';
import {
  ASSESSMENT_REVIEW_POLICY,
  type AssessmentReviewBindingT,
  assessmentReviewOperationId,
  matchesAssessmentReviewBinding,
  projectAssessmentReviewMedia,
  projectAssessmentReviewQuestion,
  readAssessmentReviewStage,
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

describe('assessment review paid-work fence', () => {
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
