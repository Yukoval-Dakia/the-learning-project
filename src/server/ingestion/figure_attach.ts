import type { BBoxT, FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { PreAttachFigure } from './crop';

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
    const containing = allQs.filter((q) => q.bbox && bboxContains(q.bbox, fig.source_bbox));

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

    // 找最近邻；若没有任何带 bbox 的题，归 root
    const candidatesWithBbox = allQs.filter((q) => q.bbox);
    if (candidatesWithBbox.length === 0) {
      return {
        ...fig,
        attached_to_index: root.id,
        attach_confidence: 'low' as const,
      };
    }

    const nearest = candidatesWithBbox.reduce((min, q) =>
      // biome-ignore lint/style/noNonNullAssertion: filter 已保证 bbox 非空
      bboxCenterDistance(q.bbox!, fig.source_bbox) <
      bboxCenterDistance(min.bbox!, fig.source_bbox)
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
