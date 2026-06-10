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
 * figures the VLM did not cover or reported with low confidence.
 *
 * Safety contract (regression invariant):
 *  - VLM covers a figure with confidence='high' AND target id exists in the
 *    question tree AND no other node claimed the same figure_index → use VLM
 *    assignment (attach_confidence='high').
 *  - VLM reported confidence='low' → treat as "uncertain" and fall back to
 *    geometric heuristic. The prompt (F1) instructs the VLM to only report
 *    figure_ids when certain; low-confidence assignments are a signal that the
 *    VLM guessed rather than determined. Geometric fallback is safer than
 *    a low-confidence VLM guess that overrides it.
 *  - VLM assigned the same figure_index to multiple nodes (conflict) → discard
 *    the whole group and fall back to geometric (R2-2). Conflicting assignments
 *    are ambiguous and overriding either choice would be wrong; geometric is
 *    more conservative. console.warn logs the conflict for visibility.
 *  - VLM did not cover a figure → geometric fallback, no figure dropped.
 *  - VLM assignments is empty/undefined → identical to calling `assignFigures`
 *    directly (zero regression on the Tencent fallback path).
 *
 * Output order contract (R2-1): the returned array is in the SAME ORDER as the
 * input `preFigures` array. Callers must not assume position === figure_index
 * but any code relying on the original preFigures order (e.g. block.figures[i]
 * corresponds to preFigures[i]) is protected. Throws if the internal
 * reconstruction leaves a gap (programming error, never normal operation).
 *
 * F1 semantic decision: only high-confidence VLM assignments are consumed;
 * low-confidence ones go to geometric fallback. This aligns with the prompt
 * change that asks the VLM to only report figure_ids when certain.
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

  // Build a set of valid question ids (P3: validate assignment targets exist).
  const validQuestionIds = new Set(flattenQuestions(questions).map((q) => q.id));

  // Build a lookup: figure_index → assignment, applying three filters:
  //  1. HIGH confidence only (F1): low-confidence → geometric fallback.
  //  2. Valid target question id (P3): hallucinated id → geometric fallback.
  //  3. No conflict (R2-2, refined in bot round-3): a repeated figure_index is
  //     only a conflict when it maps to a DIFFERENT question id — the VLM
  //     redundantly repeating the same (figure, question) pair is harmless and
  //     keeps the assignment. Diverging claims discard the whole group →
  //     geometric fallback. Conflicts are logged via console.warn.
  const conflictIndices = new Set<number>();
  const assignmentByIndex = new Map<number, FigureAssignment>();

  for (const a of figureAssignments ?? []) {
    if (a.confidence !== 'high' || !validQuestionIds.has(a.attached_to_question_id)) {
      // Low confidence or invalid target — skip silently (will fall to geometric).
      continue;
    }
    const existing = assignmentByIndex.get(a.figure_index);
    if (existing) {
      if (existing.attached_to_question_id !== a.attached_to_question_id) {
        // Same figure claimed for different questions → real conflict.
        conflictIndices.add(a.figure_index);
      }
      // Same target → harmless duplicate; keep the existing mapping.
    } else if (!conflictIndices.has(a.figure_index)) {
      assignmentByIndex.set(a.figure_index, a);
    }
  }

  // Remove conflicting indices from the lookup so they fall to geometric fallback.
  for (const ci of conflictIndices) {
    assignmentByIndex.delete(ci);
    console.warn(
      `[assignFiguresFromVlm] figure_index=${ci} was claimed by multiple VLM nodes; discarding all claims — falling back to geometric heuristic (R2-2)`,
    );
  }

  // R2-1: reconstruct output in original preFigures order.
  // Figures going to geometric fallback are collected, run through assignFigures,
  // then re-inserted at their original positions so the output array is always
  // index-stable with respect to the input preFigures array.
  const geometricFigures: PreAttachFigure[] = [];
  const geometricOriginalPositions: number[] = [];

  for (let i = 0; i < preFigures.length; i++) {
    if (!assignmentByIndex.has(i)) {
      geometricFigures.push(preFigures[i]);
      geometricOriginalPositions.push(i);
    }
  }

  const geometricRefs: FigureRefT[] =
    geometricFigures.length > 0 ? assignFigures(geometricFigures, questions) : [];

  // Build the output array in original preFigures order.
  const result: (FigureRefT | undefined)[] = new Array(preFigures.length);

  // Place VLM-assigned figures at their original positions.
  for (let i = 0; i < preFigures.length; i++) {
    const assignment = assignmentByIndex.get(i);
    if (assignment) {
      result[i] = {
        ...preFigures[i],
        attached_to_index: assignment.attached_to_question_id,
        attach_confidence: assignment.confidence,
      };
    }
  }

  // Place geometric-fallback figures at their original positions.
  for (let g = 0; g < geometricOriginalPositions.length; g++) {
    const pos = geometricOriginalPositions[g];
    result[pos] = geometricRefs[g];
  }

  // Sanity check: no gaps (programming error if this fires).
  for (let i = 0; i < result.length; i++) {
    if (result[i] === undefined) {
      throw new Error(
        `assignFiguresFromVlm: internal error — result[${i}] is undefined (gap in reconstruction). ` +
          `preFigures.length=${preFigures.length}`,
      );
    }
  }

  return result as FigureRefT[];
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
