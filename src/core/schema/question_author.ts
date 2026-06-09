// ADR-0031 / YUK-304 (quiz C→A, lane B) — QuestionAuthorTask LLM output schema +
// the server-side normalization barrier for the LLM-emitted StructuredQuestion
// tree.
//
// The author_question knowledge|material seed runs ONE single-shot structured
// call (QuestionAuthorTask — 决定6: NOT the QuizGenTask agent loop; no Tavily, no
// 8-iteration budget) that emits exactly ONE question as this shape. 材料/阅读
// kinds emit an Axis-A tree (stem 节点带 passage + sub_questions[]，吸收 YUK-302
// 的 composite-generation piece)；其余题型 emit a single standalone node — 与 OCR
// 题组 / /practice / 判分同构 (ADR-0031 决定4).
//
// prompt_md / reference_md are DERIVED, not LLM fields: structuredToPromptMarkdown /
// structuredToReferenceMarkdown — the same derivation the OCR import path uses, so
// the persisted row renders identically everywhere.
//
// Normalization discipline (lane-B critic #6): the repo never trusts LLM-minted
// ids ("hallucinated ids filtered code-side"). `normalizeAuthorStructured`
// regenerates every node id server-side, rejects malformed root shapes (root
// role 'sub', stem without sub_questions, non-'sub' children), and rejects
// empty derived prompt_md / reference_md (quiz_gen's min(1) discipline) BEFORE
// any insert.

import { z } from 'zod';
import { newId } from '../ids';
import { QuestionKind, Rubric } from './business';
import {
  StructuredQuestion,
  type StructuredQuestionT,
  structuredToPromptMarkdown,
  structuredToReferenceMarkdown,
} from './structured_question';

// ---------- LLM output shape (one question per call) ----------

export const QuestionAuthorDraft = z.object({
  kind: QuestionKind,
  difficulty: z.number().int().min(1).max(5),
  // Echo of the seed knowledge ids — validated CODE-SIDE against the live
  // knowledge table (runQuestionAuthor intersects; never trusted verbatim).
  knowledge_ids: z.array(z.string().min(1)),
  // The Axis-A tree: stem+sub for 材料/阅读, standalone otherwise. Node ids are
  // regenerated server-side (normalizeAuthorStructured) — the LLM's ids are
  // placeholders only.
  structured: StructuredQuestion,
  choices_md: z.array(z.string().min(1)).max(6).nullable().optional(),
  // Only runnable generator routes — same rationale as QuizGenQuestion
  // (quiz_gen.ts judge_kind_override comment): steps / unit_dimension are
  // profile-preferred first-class routes, 'rubric' has no runner.
  judge_kind_override: z.enum(['exact', 'keyword', 'semantic']).nullable().optional(),
  rubric_json: Rubric.nullable().optional(),
});
export type QuestionAuthorDraftT = z.infer<typeof QuestionAuthorDraft>;

// ---------- server-side normalization barrier ----------

export interface NormalizedAuthorStructured {
  /** The tree with every node id regenerated server-side. */
  structured: StructuredQuestionT;
  /** Derived via structuredToPromptMarkdown — guaranteed non-empty. */
  prompt_md: string;
  /** Derived via structuredToReferenceMarkdown — guaranteed non-empty. */
  reference_md: string;
}

function hasReferenceContent(node: StructuredQuestionT): boolean {
  return (
    (node.answers?.some((a) => a.trim().length > 0) ?? false) ||
    (node.analysis?.trim().length ?? 0) > 0
  );
}

/**
 * Normalize an LLM-emitted StructuredQuestion tree for persistence.
 *
 * Hard rejects (throws — the caller maps to a generation failure):
 *   - root role 'sub' (a sub node only exists under a stem);
 *   - stem with zero sub_questions (a container with nothing inside);
 *   - a stem child whose role is not 'sub' (no nested stems / standalones —
 *     one level of 大题/小题, matching the OCR import shape);
 *   - any node with an empty prompt_text;
 *   - any LEAF (sub / standalone) with neither answers nor analysis — the
 *     derived reference_md must cover every leaf, or judging is impossible;
 *   - empty derived prompt_md / reference_md (defense-in-depth; quiz_gen's
 *     min(1) discipline).
 *
 * Node ids are regenerated via `genId` (injectable for deterministic tests)
 * regardless of what the LLM emitted: uniqueness/non-emptiness must not depend
 * on model behaviour (part_ref / figure attachment key on node ids).
 */
export function normalizeAuthorStructured(
  tree: StructuredQuestionT,
  genId: () => string = newId,
): NormalizedAuthorStructured {
  if (tree.role === 'sub') {
    throw new Error("question_author: root node may not have role 'sub'");
  }
  if (tree.prompt_text.trim().length === 0) {
    throw new Error('question_author: root prompt_text must be non-empty');
  }
  let structured: StructuredQuestionT;
  if (tree.role === 'stem') {
    const subs = tree.sub_questions ?? [];
    if (subs.length === 0) {
      throw new Error('question_author: a stem node requires at least one sub_question');
    }
    structured = {
      ...tree,
      id: genId(),
      sub_questions: subs.map((sub) => {
        if (sub.role !== 'sub') {
          throw new Error(
            `question_author: stem children must have role 'sub' (got '${sub.role}')`,
          );
        }
        if (sub.prompt_text.trim().length === 0) {
          throw new Error('question_author: sub_question prompt_text must be non-empty');
        }
        if (!hasReferenceContent(sub)) {
          throw new Error(
            'question_author: every sub_question needs answers and/or analysis (reference content)',
          );
        }
        // The StructuredQuestion refine already rejects a non-stem node carrying
        // sub_questions, so one level of nesting is guaranteed by parse time.
        return { ...sub, id: genId() };
      }),
    };
  } else {
    // standalone — the refine guarantees no sub_questions.
    if (!hasReferenceContent(tree)) {
      throw new Error(
        'question_author: a standalone question needs answers and/or analysis (reference content)',
      );
    }
    structured = { ...tree, id: genId() };
  }

  const promptMd = structuredToPromptMarkdown(structured);
  const referenceMd = structuredToReferenceMarkdown(structured);
  if (promptMd.trim().length === 0) {
    throw new Error('question_author: derived prompt_md is empty');
  }
  if (referenceMd.trim().length === 0) {
    throw new Error('question_author: derived reference_md is empty');
  }
  return { structured, prompt_md: promptMd, reference_md: referenceMd };
}
