import type { StructuredQuestionT } from '@/core/schema/structured_question';

/**
 * Source assets remain in document page order. Narrow only complete valid node
 * page mappings; retain the original evidence on incomplete legacy mappings.
 * Printed reference pages are part of the same question's evidence.
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
    // Number.isInteger (not `typeof === 'number'`): the schema types page_index as int≥0, but
    // structured is jsonb and an agent-edit / malformed VLM output could carry NaN or a float.
    // typeof would admit those; then NaN slips the out-of-range guard below (NaN<0 and
    // NaN>=len are both false) → all[NaN] = undefined fed to R2/judge. Integer-only entry keeps
    // such a node OUT of the trusted set (and, via the complete-signal gate below, forces the
    // feed-all fallback). (augment review #573 + independent reviewer #7.)
    const pi = node.page_index;
    if (typeof pi === 'number' && Number.isInteger(pi)) {
      pages.add(pi);
      nodesWithPage += 1;
    }
    const reference = node.extraction_evidence?.reference_extraction;
    if (reference?.origin === 'printed' && reference.page_index != null) {
      if (!Number.isInteger(reference.page_index)) return all;
      pages.add(reference.page_index);
    }
    if (node.sub_questions) {
      for (const sub of node.sub_questions) stack.push(sub);
    }
  }
  // COMPLETE-signal gate (concern #2 — both reviewers): scope ONLY when EVERY node in the subtree
  // carries a valid integer page_index. PARTIAL population (some nodes have it, some don't) is NOT
  // trusted: a sub on a page whose node omitted page_index would be DROPPED, starving the judge of
  // the answer page (the VLM does not guarantee per-node page_index — figure_attach.ts:27 documents
  // the same partial-population reality). Partial OR zero signal → feed all (today's behavior, ZERO
  // regression — the conservative direction: never drop a page the answer might be on). The
  // dominant win is preserved: a standalone question wholly on one page has its single node carry
  // page_index → complete → scoped; a cross-page 大题 narrows only when the VLM stamped EVERY node.
  if (pages.size === 0 || nodesWithPage < totalNodes) return all;
  const sorted = [...pages].sort((a, b) => a - b);
  // Belt-and-suspenders: any out-of-range index ⇒ the page map is untrustworthy → feed all.
  if (sorted.some((p) => p < 0 || p >= all.length)) return all;
  return sorted.map((p) => all[p]);
}
