import type { BBoxT, FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { PreAttachFigure } from './crop';
import type { FigureAssignment } from './structure';

/**
 * Figure 归属启发式（spec § 1.7.1 (a)）:
 *
 *   1. 空间包含：图的 bbox 完全在某题 bbox 内 → 该题为候选
 *   2. 多候选取最小覆盖（最贴近父）→ attach_confidence='high'
 *   3. 零候选取最近邻（中心距离最小）→ attach_confidence='low'
 *   4. 兜底：归到 root（第一个 stem 或 standalone）+ 'low'
 */
export function assignFigures(
  figures: PreAttachFigure[],
  questions: StructuredQuestionT[],
): FigureRefT[] {
  if (figures.length === 0) return [];

  const allQs = flattenQuestions(questions);
  const root = questions[0];
  if (!root) {
    throw new Error('assignFigures: questions must contain at least one question');
  }

  return figures.map((fig) => {
    // Page-gate (YUK-163): restrict candidates to questions on the figure's source
    // page. The Tencent multi-page path stamps page_index on every question (parser),
    // so a page-1 figure only competes for page-1 questions and can't win a page-0
    // question on normalized (0–1) bbox overlap. VLM / single-page trees carry no
    // page_index → samePageQs is empty → we use the full set, i.e. exactly the prior
    // behavior (no regression on the VLM happy path, where questions have no bbox and
    // every figure lands on root anyway).
    const samePageQs = allQs.filter((q) => q.page_index === fig.source_page_index);
    const scope = samePageQs.length > 0 ? samePageQs : allQs;
    const scopeRoot = samePageQs[0] ?? root;

    const containing = scope.filter((q) => q.bbox && bboxContains(q.bbox, fig.source_bbox));

    if (containing.length > 0) {
      const smallest = containing.reduce((min, q) =>
        // biome-ignore lint/style/noNonNullAssertion: bbox 在 containing 内必非空
        bboxArea(q.bbox!) < bboxArea(min.bbox!) ? q : min,
      );
      return {
        ...fig,
        attached_to_index: smallest.id,
        attach_confidence: 'high' as const,
      };
    }

    // 找最近邻；若（同页/全局）没有任何带 bbox 的题，归 scope root
    const candidatesWithBbox = scope.filter((q) => q.bbox);
    if (candidatesWithBbox.length === 0) {
      return {
        ...fig,
        attached_to_index: scopeRoot.id,
        attach_confidence: 'low' as const,
      };
    }

    const nearest = candidatesWithBbox.reduce((min, q) =>
      // biome-ignore lint/style/noNonNullAssertion: filter 已保证 bbox 非空
      bboxCenterDistance(q.bbox!, fig.source_bbox) < bboxCenterDistance(min.bbox!, fig.source_bbox)
        ? q
        : min,
    );
    return {
      ...fig,
      attached_to_index: nearest.id,
      attach_confidence: 'low' as const,
    };
  });
}

// ---------- YUK-227 S3 Slice A — VLM-first figure assignment ----------

/**
 * Assign figures to questions using VLM-reported assignments as the primary
 * signal, falling back to the geometric `assignFigures` heuristic for any
 * figures the VLM did not cover.
 *
 * Safety contract (regression invariant):
 *  - VLM covers a figure → use VLM assignment (confidence='high').
 *  - VLM did not cover a figure → geometric fallback (`assignFigures`),
 *    confidence='low'. No figure is ever dropped.
 *  - VLM assignments is empty/undefined → identical to calling `assignFigures`
 *    directly (zero regression on the Tencent fallback path).
 *
 * F3 note: if VLM figure attribution is found to pollute structure quality in
 * practice, this function remains safe — the VLM simply omits figure_ids and
 * everything falls back to the geometric heuristic. Escalate to plan §6 F3 if
 * attribution needs to be a separate task.
 */
export function assignFiguresFromVlm(
  preFigures: PreAttachFigure[],
  figureAssignments: FigureAssignment[] | undefined,
  questions: StructuredQuestionT[],
): FigureRefT[] {
  if (preFigures.length === 0) return [];

  // Build a lookup: figure_index → assignment (first-win if duplicate indices).
  const assignmentByIndex = new Map<number, FigureAssignment>();
  for (const a of figureAssignments ?? []) {
    if (!assignmentByIndex.has(a.figure_index)) {
      assignmentByIndex.set(a.figure_index, a);
    }
  }

  // Build a lookup: question_id → StructuredQuestionT (needed for FigureRefT shape).
  // assignFigures only needs `questions` array; FigureRefT doesn't embed the question
  // object — we just need the id string from the assignment.

  // Separate covered (VLM) vs uncovered (geometric fallback) figures.
  const vlmCovered: PreAttachFigure[] = [];
  const vlmCoveredIndices: number[] = [];
  const geometric: PreAttachFigure[] = [];

  preFigures.forEach((fig, i) => {
    if (assignmentByIndex.has(i)) {
      vlmCovered.push(fig);
      vlmCoveredIndices.push(i);
    } else {
      geometric.push(fig);
    }
  });

  // VLM-assigned figures → directly produce FigureRefT with high confidence.
  const vlmRefs: FigureRefT[] = vlmCovered.map((fig, pos) => {
    const idx = vlmCoveredIndices[pos];
    // biome-ignore lint/style/noNonNullAssertion: idx guaranteed in map above
    const assignment = assignmentByIndex.get(idx)!;
    return {
      ...fig,
      attached_to_index: assignment.attached_to_question_id,
      attach_confidence: assignment.confidence,
    };
  });

  // Geometric fallback for uncovered figures (preserves existing behaviour).
  const geometricRefs: FigureRefT[] =
    geometric.length > 0 ? assignFigures(geometric, questions) : [];

  return [...vlmRefs, ...geometricRefs];
}

// ---------- 几何 helpers ----------

function flattenQuestions(qs: StructuredQuestionT[]): StructuredQuestionT[] {
  const out: StructuredQuestionT[] = [];
  for (const q of qs) {
    out.push(q);
    if (q.sub_questions) out.push(...flattenQuestions(q.sub_questions));
  }
  return out;
}

function bboxContains(outer: BBoxT, inner: BBoxT): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function bboxArea(b: BBoxT): number {
  return b.width * b.height;
}

function bboxCenter(b: BBoxT): { cx: number; cy: number } {
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}

function bboxCenterDistance(a: BBoxT, b: BBoxT): number {
  const ca = bboxCenter(a);
  const cb = bboxCenter(b);
  return Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
}
