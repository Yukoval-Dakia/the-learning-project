// YUK-212 + YUK-484(B) "Lane C cut 1" — sub-question judge narrowing.
//
// Narrows a JudgeQuestionRow so the judge grades ONLY the target structured
// sub-node addressed by `part_ref` (= StructuredQuestion.id), instead of the
// whole multi-sub row. This is the load-bearing piece that closes the critic-C1
// leak: semanticInput() (question-contract.ts) passes `question.structured` into
// the task input and runner.ts JSON.stringifies the entire input into the model
// message, so leaving `structured` whole-row would leak EVERY sibling sub to the
// semantic judge (short_answer / reading / translation / essay). Narrowing
// `structured` to the single-sub stem closes it.
//
// Option B (ADR-0028): part_ref / sub_ref live STRICTLY on the structured-jsonb
// axis (= StructuredQuestion.id) — NOT the question_part / T-QP axis. There are
// no question_part rows, no per-小题 FSRS, no per-sub θ̂ fan-out. Mastery stays
// per-KC (one updateThetaForAttempt per attempt keyed on referenced_knowledge_ids).
// This helper is pure read-time derivation off the already-stored `structured`
// jsonb plus the additive `sub_ref` event field.

import {
  type StructuredQuestionT,
  structuredToPromptMarkdown,
  structuredToReferenceMarkdown,
} from '@/core/schema/structured_question';
import type { JudgeQuestionRow } from '@/server/ai/judges/question-contract';

/**
 * Locate the FIRST node (depth-first pre-order) whose `id` matches `target`,
 * together with its immediate parent stem. Returns `{ node, parent }` where
 * `parent` is undefined for a top-level / standalone match. Read-only — returns
 * live node references, no clone.
 *
 * First-match is safe: ids are UNIQUE per tree (ADR-0032 read≡write coords).
 */
function findNodeWithParent(
  node: StructuredQuestionT,
  target: string,
  parent?: StructuredQuestionT,
): { node: StructuredQuestionT; parent?: StructuredQuestionT } | undefined {
  if (node.id === target) return { node, parent };
  for (const sub of node.sub_questions ?? []) {
    const hit = findNodeWithParent(sub, target, node);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Narrow `question` to the structured sub-node addressed by `partRef`, returning
 * a shallow-cloned JudgeQuestionRow — OR the input row UNCHANGED (`===`) when the
 * narrowing is a no-op.
 *
 * No-op (returns the input by reference, so the invoker can short-circuit) when:
 *   - `partRef` is null/undefined; OR
 *   - `question.structured` is null/undefined; OR
 *   - the node id is not found in the tree (whole-row fallback = today's behavior).
 *
 * When the node IS found, build a PASSAGE-PRESERVING narrowed `structured`:
 *   - if the node has an immediate parent stem, keep that stem (its passage
 *     `prompt_text`) but replace its `sub_questions` with just `[node]` — this
 *     drops sibling subs while preserving the passage context the sub depends on
 *     (e.g. 阅读下文…); otherwise the node is standalone / top-level → it is itself.
 *   - derive prompt_md / reference_md from the narrowed subtree.
 *
 * CRITICAL (critic C1): the returned row's `structured` is the narrowed subtree,
 * NOT just prompt_md — see this file's header for why leaving structured whole-row
 * leaks every sibling sub to the semantic judge.
 *
 * Out of scope (left WHOLE-ROW): choices_md / rubric_json / image_refs / kind /
 * figures. route-resolve reads only kind / rubric_json / choices_md / image_refs /
 * judge_kind_override, so narrowing them is unnecessary to close the leak and
 * figure narrowing is deferred to a later cut.
 */
export function narrowQuestionToPart(
  question: JudgeQuestionRow,
  partRef: string | null | undefined,
): JudgeQuestionRow {
  if (partRef == null) return question;
  const structured = question.structured;
  if (structured == null) return question;

  const hit = findNodeWithParent(structured, partRef);
  if (!hit) return question; // node not found → whole-row fallback (today's behavior).

  const { node, parent } = hit;
  // Passage-preserving narrowing: keep the parent stem (its passage prompt_text)
  // but drop the sibling subs; standalone / top-level node → itself.
  const narrowedStructured: StructuredQuestionT =
    parent && parent.role === 'stem' ? { ...parent, sub_questions: [node] } : node;

  const prompt_md = structuredToPromptMarkdown(narrowedStructured);
  // reference_md is derived ONLY from the narrowed subtree (stem passage + this
  // sub). Do NOT fall back to the whole-row question.reference_md when the sub has
  // no stored answer: the whole-row reference is structuredToReferenceMarkdown over
  // the FULL tree (every sibling sub's answers), so a fallback would re-open the
  // C1 leak via semanticInput().reference_md (which the runner JSON.stringifies into
  // the model message). An empty reference for an answer-less sub is strictly safer
  // than leaking siblings — and loses nothing, since the whole-row reference holds
  // no extra answer for THIS sub (same derivation source). Answer-less subs route to
  // the semantic/vision judge, which grades by solving independently.
  const reference_md = structuredToReferenceMarkdown(narrowedStructured);

  return { ...question, structured: narrowedStructured, prompt_md, reference_md };
}
