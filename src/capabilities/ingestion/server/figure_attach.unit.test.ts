import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { normalizeQuestionRowToContract } from '@/kernel/records/assessment-normalization';
import { assignFiguresFromVlm, figuresForQuestion } from './figure_attach';

const question: StructuredQuestionT = {
  id: 'question',
  role: 'standalone',
  prompt_text: 'Read the printed diagram.',
  page_index: 0,
  source: 'vlm_structure',
  student_answer_present: false,
};
const figure: FigureRefT = {
  asset_id: 'page-fig-0',
  role: 'diagram',
  source_page_index: 0,
  source_bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  attached_to_index: 'question',
  attach_confidence: 'manual',
};
const digest = createHash('sha256').update('retained printed crop bytes').digest('hex');
const asset = { id: figure.asset_id, storage_key: 'figures/page-fig-0.png', sha256: digest };

function publicFigureAssets(node: StructuredQuestionT, assets: (typeof asset)[]) {
  const contract = normalizeQuestionRowToContract({
    id: 'group',
    kind: 'short_answer',
    prompt_md: node.prompt_text,
    reference_md: null,
    choices_md: null,
    rubric_json: null,
    judge_kind_override: null,
    structured: node,
    figures: figuresForQuestion(node, [figure], { sourceAssetIds: ['page'], assets }),
    figureDigests: Object.fromEntries(assets.map((item) => [item.id, item.sha256])),
  });
  return contract.structure.materials
    .filter((material) => material.kind === 'figure')
    .map((material) => material.asset.asset_id);
}

describe('prospective ingestion figure privacy', () => {
  // @invariant security: flagged student pixels never enter public figure materials, even after manual attachment; retained originals are unchanged
  // @fails-if remove the student-work exclusion in figuresForQuestion; the normalizer emits page-fig-0 as a public figure
  it('withholds VLM and OCR student-work evidence from prospective public materials', () => {
    const originals = structuredClone(figure);
    for (const node of [
      { ...question, student_answer_present: true },
      {
        ...question,
        role: 'stem' as const,
        sub_questions: [
          {
            ...question,
            id: 'child',
            role: 'sub' as const,
            extraction_evidence: { handwriting: [{ text: 'private', bbox: figure.source_bbox }] },
          },
        ],
      },
    ]) {
      expect(publicFigureAssets(node, [asset])).toEqual([]);
    }
    expect(figure).toEqual(originals);
  });

  // @invariant security: unverified or foreign source bytes cannot be emitted as public figure assets; only the owned crop with verified metadata passes
  // @fails-if bypass the crop ownership or digest metadata checks in figuresForQuestion; an unverified/foreign crop appears in public materials
  it('requires verified crop metadata and the actual source-page asset', () => {
    expect(publicFigureAssets(question, [])).toEqual([]);
    expect(publicFigureAssets(question, [{ ...asset, sha256: 'unverified:page-fig-0' }])).toEqual(
      [],
    );
    expect(
      publicFigureAssets(question, [{ ...asset, storage_key: 'private/student-work.png' }]),
    ).toEqual([]);
    expect(publicFigureAssets(question, [asset])).toEqual(['page-fig-0']);
    expect(
      figuresForQuestion(question, [figure], { sourceAssetIds: ['another-page'], assets: [asset] }),
    ).toEqual([]);
    expect(
      figuresForQuestion(
        question,
        [{ ...figure, source_bbox: { x: 0, y: 0, width: 1, height: 1 } }],
        { sourceAssetIds: ['page'], assets: [asset] },
      ),
    ).toEqual([]);
  });

  // @invariant security: missing visibility evidence remains private; one clean node cannot certify unknown nodes in its captured question tree
  // @fails-if remove the explicit clean-visibility check in figuresForQuestion; a verified crop on an unknown node enters public figure materials
  it('withholds unknown visibility while permitting a verified clean crop', () => {
    expect(publicFigureAssets({ ...question, student_answer_present: undefined }, [asset])).toEqual(
      [],
    );
    expect(
      publicFigureAssets(
        {
          ...question,
          role: 'stem',
          sub_questions: [
            { ...question, id: 'child', role: 'sub', student_answer_present: undefined },
          ],
        },
        [asset],
      ),
    ).toEqual([]);
    expect(publicFigureAssets(question, [asset])).toEqual(['page-fig-0']);
  });

  // @invariant security: a VLM diagram claim on a page with student work cannot promote private pixels into another question's public figure input
  // @fails-if remove hasPrivateSource from assignFiguresFromVlm; the private page crop binds to the clean-looking neighboring question
  it('withholds a page crop when a neighboring node flags private student work', () => {
    expect(
      assignFiguresFromVlm(
        [figure],
        [{ figure_index: 0, attached_to_question_id: question.id, confidence: 'high' }],
        [question, { ...question, id: 'neighbor', student_answer_present: true }],
      ),
    ).toEqual([]);
  });
});
