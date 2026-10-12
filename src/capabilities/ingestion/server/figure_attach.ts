import type { BBoxT, FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { source_asset } from '@/db/schema';
import type { PreAttachFigure } from './crop';
import type { FigureAssignment } from './structure';

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
    if (figure.attach_confidence === 'low' || !questionIds.has(figure.attached_to_index))
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
    if (hasPrivateSource(figure, nodes)) return [];
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
    if (!target || nodes.filter((node) => node.id === target.id).length !== 1) return [];
    return [{ ...figure, attached_to_index: target.id, attach_confidence: 'high' }];
  });
}

/** VLM claims must name one existing node; omitted or conflicting claims stay unbound. */
export function assignFiguresFromVlm(
  preFigures: PreAttachFigure[],
  figureAssignments: FigureAssignment[] | undefined,
  questions: StructuredQuestionT[],
): FigureRefT[] {
  const nodes = flattenQuestions(questions);
  return preFigures.flatMap((figure, index): FigureRefT[] => {
    if (hasPrivateSource(figure, nodes)) return [];
    const claims = (figureAssignments ?? []).filter((claim) => claim.figure_index === index);
    const targets = new Set(claims.map((claim) => claim.attached_to_question_id));
    const claim = claims[0];
    if (!claim || targets.size !== 1 || claims.some((item) => item.confidence !== 'high'))
      return [];
    const matchingNodes = nodes.filter((node) => node.id === claim.attached_to_question_id);
    if (matchingNodes.length !== 1 || hasStudentWork(matchingNodes[0])) return [];
    return [
      {
        ...figure,
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

function hasPrivateSource(figure: PreAttachFigure, nodes: StructuredQuestionT[]): boolean {
  return nodes.some(
    (node) =>
      hasStudentWork(node) &&
      (node.page_index === undefined || node.page_index === figure.source_page_index),
  );
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
