import type { BBoxT, FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { source_asset } from '@/db/schema';
import type { PreAttachFigure } from './crop';
import type { FigureAssignment, StructureResult } from './structure';

export type FigureHandwritingEvidence = {
  judgments?: StructureResult['figureHandwriting'];
  ocrQuestions?: StructuredQuestionT[];
};

type PublicFigureEvidence = {
  sourceAssetIds: readonly string[];
  assets: readonly Pick<typeof source_asset.$inferSelect, 'id' | 'storage_key' | 'sha256'>[];
};

/** Source ownership is retained on blocks; publication also needs verified crop metadata. */
export function figuresForQuestion(
  question: StructuredQuestionT | null,
  figures: readonly FigureRefT[],
  publicEvidence?: PublicFigureEvidence,
): FigureRefT[] {
  if (!question) return [];
  const nodes = flattenQuestions([question]);
  if (nodes.some(hasStudentWork)) return [];
  if (
    publicEvidence &&
    nodes.some(
      (node) =>
        node.student_answer_present !== false &&
        !(node.source === 'tencent_ocr' && node.extraction_evidence?.handwriting?.length === 0),
    )
  )
    return [];
  const questionIds = new Set(nodes.map((node) => node.id));
  const assets = new Map(publicEvidence?.assets.map((asset) => [asset.id, asset]));
  return figures.filter((figure) => {
    if (
      bboxArea(figure.source_bbox) >= 1 ||
      figure.attach_confidence === 'low' ||
      !questionIds.has(figure.attached_to_index)
    )
      return false;
    if (!publicEvidence) return true;
    // A clean question does not establish visibility of an entire source page.
    if (bboxArea(figure.source_bbox) >= 1) return false;
    const pageAssetId = publicEvidence.sourceAssetIds[figure.source_page_index];
    const cropPrefix = `${pageAssetId}-fig-`;
    const asset = assets.get(figure.asset_id);
    return (
      pageAssetId !== undefined &&
      figure.asset_id.startsWith(cropPrefix) &&
      /^\d+$/.test(figure.asset_id.slice(cropPrefix.length)) &&
      asset?.storage_key === `figures/${figure.asset_id}.png` &&
      /^[a-f0-9]{64}$/i.test(asset.sha256)
    );
  });
}

/** OCR fallback: only unique, innermost containment on the actual source page. */
export function assignFigures(
  figures: PreAttachFigure[],
  questions: StructuredQuestionT[],
): FigureRefT[] {
  const nodes = flattenQuestions(questions);
  return figures.flatMap((figure): FigureRefT[] => {
    const handwriting = cropHandwriting(figure, -1, { ocrQuestions: questions });
    if (bboxArea(figure.source_bbox) >= 1 || handwriting === true) return [];
    const containing = nodes.flatMap((node) =>
      node.page_index === figure.source_page_index &&
      node.source !== 'glm_ocr' &&
      node.bbox &&
      bboxArea(node.bbox) < 1 &&
      bboxContains(node.bbox, figure.source_bbox)
        ? [{ node, bbox: node.bbox }]
        : [],
    );
    const innermost = containing.filter((candidate) =>
      containing.every((other) => bboxContains(other.bbox, candidate.bbox)),
    );
    const target = innermost.length === 1 ? innermost[0].node : undefined;
    if (
      !target ||
      hasStudentWork(target) ||
      nodes.filter((node) => node.id === target.id).length !== 1
    )
      return [];
    return [
      {
        ...figure,
        attached_to_index: target.id,
        attach_confidence: 'high',
        handwriting_unverified: handwriting === null,
      },
    ];
  });
}

/** VLM claims must name one existing node; omitted or conflicting claims stay unbound. */
export function assignFiguresFromVlm(
  preFigures: PreAttachFigure[],
  figureAssignments: FigureAssignment[] | undefined,
  questions: StructuredQuestionT[],
  handwritingEvidence: FigureHandwritingEvidence = {},
): FigureRefT[] {
  const nodes = flattenQuestions(questions);
  return preFigures.flatMap((figure, index): FigureRefT[] => {
    const handwriting = cropHandwriting(figure, index, handwritingEvidence);
    if (bboxArea(figure.source_bbox) >= 1 || handwriting === true) return [];
    const claims = (figureAssignments ?? []).filter((claim) => claim.figure_index === index);
    const targets = new Set(
      claims.map((claim) =>
        JSON.stringify([claim.attached_to_question_id, claim.option_label ?? null]),
      ),
    );
    const claim = claims[0];
    if (!claim || targets.size !== 1 || claims.some((item) => item.confidence !== 'high'))
      return [];
    const matchingNodes = nodes.filter((node) => node.id === claim.attached_to_question_id);
    if (matchingNodes.length !== 1 || hasStudentWork(matchingNodes[0])) return [];
    // FigureRef.option_label requires a non-empty value. An empty option label
    // cannot be represented, so leave the crop withheld instead of writing a row
    // the block read schema rejects.
    if (claim.option_label !== undefined && claim.option_label.length === 0) return [];
    if (
      claim.option_label !== undefined &&
      matchingNodes[0].options?.filter((option) => option.label === claim.option_label).length !== 1
    )
      return [];
    return [
      {
        ...figure,
        option_label: claim.option_label,
        handwriting_unverified: handwriting === null,
        attached_to_index: claim.attached_to_question_id,
        attach_confidence: 'high',
      },
    ];
  });
}

function flattenQuestions(questions: StructuredQuestionT[]): StructuredQuestionT[] {
  return questions.flatMap((question) => [
    question,
    ...flattenQuestions(question.sub_questions ?? []),
  ]);
}

function hasStudentWork(question: StructuredQuestionT): boolean {
  return (
    question.student_answer_present === true ||
    (question.extraction_evidence?.handwriting?.length ?? 0) > 0
  );
}

/** Positive OCR overlap wins; omitted or contradictory crop judgments remain unverified. */
function cropHandwriting(
  figure: PreAttachFigure,
  index: number,
  evidence: FigureHandwritingEvidence,
): boolean | null {
  for (const node of flattenQuestions(evidence.ocrQuestions ?? [])) {
    if (node.page_index !== figure.source_page_index) continue;
    if (
      node.extraction_evidence?.handwriting?.some(
        ({ bbox }) =>
          bboxArea(bbox) > 0 &&
          bbox.x < figure.source_bbox.x + figure.source_bbox.width &&
          bbox.x + bbox.width > figure.source_bbox.x &&
          bbox.y < figure.source_bbox.y + figure.source_bbox.height &&
          bbox.y + bbox.height > figure.source_bbox.y,
      )
    )
      return true;
  }
  const judgments = (evidence.judgments ?? []).filter((item) => item.figure_index === index);
  if (judgments.some((item) => item.student_answer_present === true)) return true;
  return judgments.length > 0 && judgments.every((item) => item.student_answer_present === false)
    ? false
    : null;
}

function bboxContains(outer: BBoxT, inner: BBoxT): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function bboxArea(bbox: BBoxT): number {
  return bbox.width * bbox.height;
}
