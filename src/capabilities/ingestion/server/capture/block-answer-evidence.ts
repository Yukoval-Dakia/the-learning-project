// Shared reading of a captured block's answer evidence: whether student work exists, and
// which source pages belong to the question. Auto-enroll and the single-block manual
// entry must answer both questions identically, so they live here instead of either path.

import type { StructuredQuestionT } from '@/core/schema/structured_question';

/**
 * Whether the block carries student work, detected from either the Tencent handwriting
 * evidence or the VLM's student_answer_present flag. Pixels stay pixels; this is not a
 * transcription. No structured tree means nothing to detect.
 */
export function detectStudentWork(block: { structured: StructuredQuestionT | null }): boolean {
  const root = block.structured;
  if (!root) return false;
  const stack: StructuredQuestionT[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.student_answer_present === true) return true;
    const handwriting = node.extraction_evidence?.handwriting;
    if (handwriting && handwriting.length > 0) return true;
    if (node.sub_questions && node.sub_questions.length > 0) {
      for (const sub of node.sub_questions) stack.push(sub);
    }
  }
  return false;
}

/**
 * Narrows the images fed to the judge to the pages this question spans,
 * avoiding cross-page bleed on multi-page uploads. Every page comes from the structured
 * subtree's page_index mapped into source_asset_ids (stored in page order).
 *
 * Falls back to all source assets unless every subtree node has a valid integer
 * page_index in range; a partial or broken signal must never drop the page holding the
 * answer. Known limit: a separate answer-sheet page outside the prompt span is dropped,
 * which surfaces as unsupported/low-confidence and routes to human review.
 */
export function pageScopedQuestionImageRefs(block: {
  structured: StructuredQuestionT | null;
  source_asset_ids: string[];
}): string[] {
  const all = block.source_asset_ids;
  const root = block.structured;
  if (!root || all.length === 0) return all;
  const pages = new Set<number>();
  let totalNodes = 0;
  let nodesWithPage = 0;
  const stack: StructuredQuestionT[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    totalNodes += 1;
    // Number.isInteger, not typeof: jsonb may carry NaN or a float, and NaN would slip
    // the range guard below and map to undefined.
    const pi = node.page_index;
    if (typeof pi === 'number' && Number.isInteger(pi)) {
      pages.add(pi);
      nodesWithPage += 1;
    }
    if (node.sub_questions) {
      for (const sub of node.sub_questions) stack.push(sub);
    }
  }
  // Scope only when every node carries a page_index. Partial population could drop the
  // page holding the answer, so it feeds all pages instead.
  if (pages.size === 0 || nodesWithPage < totalNodes) return all;
  const sorted = [...pages].sort((a, b) => a - b);
  // An out-of-range index makes the page map untrustworthy.
  if (sorted.some((p) => p < 0 || p >= all.length)) return all;
  return sorted.map((p) => all[p]);
}
