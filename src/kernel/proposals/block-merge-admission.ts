// YUK-1404 — block_merge learner-admission proof. A merge proposal is only
// learner-visible / acceptable when the STORED question_block rows prove the
// merge joins one question, deterministically:
//
//   1. every block in the chain shares ONE ingestion_session_id (matching the
//      proposal's declared session),
//   2. every block shares ONE canonical source_document_id that resolves to a
//      real source_document row,
//   3. page facts are unambiguous: every block carries page_spans forming a
//      strictly +1 integer sequence in stored order (non-integer, duplicated,
//      out-of-order or internally gapped spans cannot prove which pages the
//      block covers), and the chain is not all-placeholder (the docx/Tencent
//      fallback paths stamp page_index 0 on every block — an all-zero chain
//      is provenance-less),
//   4. ordered adjacent pages IN THE ORDER mergeQuestions WILL MUTATE: the
//      primitive absorbs in caller mergeIds sequence (primary first, then
//      each listed id), so the chain proven here is the effective payload
//      order — never a re-sorted order — and each next block's first page
//      must be exactly prev.max+1 (same page, overlap, backward order and
//      gaps all fail closed as pages_not_adjacent),
//   5. deterministic continuity evidence per adjacent pair: the next block
//      carries no own question number, OR a same-style sub-numbering
//      continues ((2) after (1)) — and NEVER an own question number that
//      could belong to a different question (the decisive veto: any
//      top-level number, or a sub number that does not continue the
//      sequence, on the next block). An own number the parser cannot read
//      (e.g. 百/两百, '5-6') is NOT "no number": it can neither conflict nor
//      continue provably, so the pair fails closed as missing_continuity.
//
// Fail-closed on every unknown: missing rows, missing/mismatched source
// documents, placeholder or missing page facts, ambiguous ordering, and any
// block without continuity evidence. Model confidence / reason / signal are
// NEVER consulted (no confidence cutoff — YUK-1404 policy); the producer's
// continuity_signal is AI evidence, not proof.
//
// The same rule is consumed at three seams so reads and writes cannot drift:
//   - inbox projection (`inbox.ts`) filters PENDING block_merge rows, so
//     ineligible proposals stay stored but invisible (the known TEST event
//     ez1jqruwav20xs92h41ri9wa drops out via this read rule — no row edit),
//   - the accept applier (`proposal-appliers.ts`) evaluates it before the
//     mergeQuestions call,
//   - `mergeQuestions` re-evaluates it INSIDE its own transaction on the
//     FOR-UPDATE-locked rows (admission hook) so the proof binds the exact
//     rows being mutated — no check-then-act window between the read rule
//     and the destructive write.

import { inArray } from 'drizzle-orm';

import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { question_block, source_document } from '@/db/schema';
import { ApiError } from '@/kernel/http';

type DbLike = Db | Tx;

// ---------------------------------------------------------------------------
// Stored-fact surface
// ---------------------------------------------------------------------------

/** The question_block fields the admission proof reads (a BlockRow superset). */
export interface BlockMergeAdmissionFacts {
  id: string;
  ingestion_session_id: string;
  source_document_id: string | null;
  page_spans: Array<{
    page_index: number;
    bbox: { x: number; y: number; width: number; height: number };
    role?: string;
  }>;
  structured: StructuredQuestionT | null;
}

export interface BlockMergeAdmissionContext {
  factsById: ReadonlyMap<string, BlockMergeAdmissionFacts>;
  /** source_document ids that actually resolve (unknown docs fail closed). */
  knownDocumentIds: ReadonlySet<string>;
}

export interface BlockMergeAdmissionInput {
  primaryBlockId: string;
  mergeBlockIds: readonly string[];
  /** The session declared on the proposal payload; must equal the chain's. */
  ingestionSessionId?: string;
}

export type BlockMergeIneligibilityReason =
  /** effective merge set empty, or a referenced block row does not exist */
  | 'blocks_missing'
  /** chain blocks share no single session, or differ from the declared one */
  | 'session_mismatch'
  /** null/empty/mismatched source_document_id, or the document row is gone */
  | 'unknown_source'
  /** empty page_spans somewhere, or the whole chain is page-0 placeholder */
  | 'ambiguous_page_index'
  /** primary not first in source order, or a page gap/enclosed span */
  | 'pages_not_adjacent'
  /** the next block carries an own question number (a different question) */
  | 'conflicting_question_number'
  /** no continuity evidence (incl. null structured content anywhere) */
  | 'missing_continuity';

export interface BlockMergeAdmissionVerdict {
  eligible: boolean;
  reason?: BlockMergeIneligibilityReason;
  /** Total blocks the merge would touch: primary + effective merge ids. */
  affectedBlockCount: number;
  /** Deduped merge ids with the primary stripped — what would actually merge. */
  effectiveMergeIds: string[];
}

export function blockMergeAdmissionInputFromPayload(
  payload: AiProposalPayloadT,
): BlockMergeAdmissionInput | null {
  if (payload.kind !== 'block_merge') return null;
  return {
    primaryBlockId: payload.proposed_change.primary_block_id,
    mergeBlockIds: payload.proposed_change.merge_block_ids,
    ingestionSessionId: payload.proposed_change.ingestion_session_id,
  };
}

// ---------------------------------------------------------------------------
// Question-number parsing (deterministic, stored-structure only)
// ---------------------------------------------------------------------------

type ParsedQuestionNo =
  | { kind: 'top'; value: number; style: 'digits' | 'cn' | 'prefixed' }
  | { kind: 'sub'; value: number; style: 'paren' | 'suffix' | 'circled' | 'letter' }
  | { kind: 'unknown' };

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** Chinese numeral ≤ 99 （一， 十一， 二十， 二十一 …). Returns null when unparseable. */
function chineseNumeralToInt(raw: string): number | null {
  const chars = [...raw];
  if (chars.length === 0) return null;
  let value = 0;
  let sawTen = false;
  let pendingDigit: number | null = null;
  for (const ch of chars) {
    if (ch === '十') {
      if (sawTen) return null;
      value += (pendingDigit ?? 1) * 10;
      pendingDigit = null;
      sawTen = true;
      continue;
    }
    const digit = CN_DIGITS[ch];
    if (digit === undefined) return null;
    if (pendingDigit !== null) return null;
    pendingDigit = digit;
  }
  if (pendingDigit !== null) value += pendingDigit;
  return value > 0 ? value : null;
}

const CN_NUMERAL_RE = /^[零一二三四五六七八九十百两]+$/;

/** Parse a stored `question_no` (or a prompt-head token of the same shape). */
export function parseQuestionNo(raw: string | null | undefined): ParsedQuestionNo | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const t = trimmed.replace(/[\s.．、:：,，;；]+$/u, '').trim();
  if (!t) return null;

  let m = /^第\s*(\d+|[零一二三四五六七八九十百两]+)\s*题?$/u.exec(t);
  if (m) {
    const value = /^\d+$/.test(m[1]) ? Number(m[1]) : chineseNumeralToInt(m[1]);
    return value ? { kind: 'top', value, style: 'prefixed' } : { kind: 'unknown' };
  }
  if (/^\d+$/.test(t)) return { kind: 'top', value: Number(t), style: 'digits' };
  if (CN_NUMERAL_RE.test(t)) {
    const value = chineseNumeralToInt(t);
    return value ? { kind: 'top', value, style: 'cn' } : { kind: 'unknown' };
  }
  m = /^[（(]\s*(\d{1,3})\s*[)）]$/u.exec(t);
  if (m) return { kind: 'sub', value: Number(m[1]), style: 'paren' };
  m = /^[（(]\s*([零一二三四五六七八九十两]+)\s*[)）]$/u.exec(t);
  if (m) {
    const value = chineseNumeralToInt(m[1]);
    return value ? { kind: 'sub', value, style: 'paren' } : { kind: 'unknown' };
  }
  m = /^(\d{1,3})[)）]$/u.exec(t);
  if (m) return { kind: 'sub', value: Number(m[1]), style: 'suffix' };
  const code = t.codePointAt(0);
  if (t.length === 1 && code !== undefined && code >= 0x2460 && code <= 0x2473) {
    // ①..⑳ — circled digits are sub-question numbering.
    return { kind: 'sub', value: code - 0x2460 + 1, style: 'circled' };
  }
  m = /^[（(]\s*([A-Za-z])\s*[)）]$/u.exec(t) ?? /^([A-Za-z])[)）]$/u.exec(t);
  if (m) return { kind: 'sub', value: m[1].toUpperCase().charCodeAt(0) - 64, style: 'letter' };
  return { kind: 'unknown' };
}

/** A visible question number leading the prompt text (question_no absent). */
function promptHeadQuestionNo(promptText: string | undefined): ParsedQuestionNo | null {
  const head = promptText?.slice(0, 24);
  if (!head) return null;
  let m = /^\s*(第\s*\d+\s*题|第\s*[零一二三四五六七八九十百两]+\s*题)/u.exec(head);
  if (m) return parseQuestionNo(m[1]);
  m = /^\s*(\d{1,3})\s*[.、．]\s*\S/u.exec(head);
  if (m) return parseQuestionNo(m[1]);
  m = /^\s*([（(]\s*\d{1,3}\s*[)）])/u.exec(head) ?? /^\s*(\d{1,3}[)）])/u.exec(head);
  if (m) return parseQuestionNo(m[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Structured-tree traversal
// ---------------------------------------------------------------------------

/** DFS leaf order — a stem's leaves are its sub_questions; a leaf is itself. */
function leavesOf(root: StructuredQuestionT): StructuredQuestionT[] {
  if (root.role === 'stem' && root.sub_questions && root.sub_questions.length > 0) {
    return root.sub_questions.flatMap(leavesOf);
  }
  return [root];
}

/** The block's leading own question number, or null when it has none. */
function leadingQuestionNo(facts: BlockMergeAdmissionFacts): ParsedQuestionNo | null {
  const root = facts.structured;
  if (!root) return null;
  const own = root.question_no?.trim();
  if (own) return parseQuestionNo(own);
  if (root.role === 'stem' && root.sub_questions && root.sub_questions.length > 0) {
    const firstSub = root.sub_questions[0].question_no?.trim();
    if (firstSub) return parseQuestionNo(firstSub);
  }
  return promptHeadQuestionNo(root.prompt_text);
}

/** The block's trailing question number — last leaf, else the root's own. */
function trailingQuestionNo(facts: BlockMergeAdmissionFacts): ParsedQuestionNo | null {
  const root = facts.structured;
  if (!root) return null;
  const leaves = leavesOf(root);
  const lastLeaf = leaves[leaves.length - 1];
  const leafNo = lastLeaf?.question_no?.trim();
  if (leafNo) return parseQuestionNo(leafNo);
  const own = root.question_no?.trim();
  return own ? parseQuestionNo(own) : null;
}

/** (2) after (1): same sub-numbering style continuing +1. */
function isSubContinuation(
  prevTrailing: ParsedQuestionNo | null,
  nextLeading: ParsedQuestionNo | null,
): boolean {
  return (
    prevTrailing?.kind === 'sub' &&
    nextLeading?.kind === 'sub' &&
    prevTrailing.style === nextLeading.style &&
    nextLeading.value === prevTrailing.value + 1
  );
}

/** A page_spans list proves a contiguous page range only when its stored
 * order is a strict +1 integer sequence (single span included). Anything
 * else — non-integer, duplicated, out-of-order, or internally gapped pages —
 * cannot prove which pages the block covers. */
function contiguousPages(facts: BlockMergeAdmissionFacts): number[] | null {
  const pages = facts.page_spans.map((s) => s.page_index);
  if (pages.length === 0) return null;
  for (let i = 0; i < pages.length; i += 1) {
    if (!Number.isInteger(pages[i]) || (i > 0 && pages[i] !== pages[i - 1] + 1)) return null;
  }
  return pages;
}

// ---------------------------------------------------------------------------
// The evaluator (pure)
// ---------------------------------------------------------------------------

export function evaluateBlockMergeAdmission(
  input: BlockMergeAdmissionInput,
  ctx: BlockMergeAdmissionContext,
): BlockMergeAdmissionVerdict {
  const effectiveMergeIds = [...new Set(input.mergeBlockIds)].filter(
    (id) => id !== input.primaryBlockId,
  );
  const base = {
    effectiveMergeIds,
    affectedBlockCount: effectiveMergeIds.length + 1,
  };
  const fail = (reason: BlockMergeIneligibilityReason): BlockMergeAdmissionVerdict => ({
    eligible: false,
    reason,
    ...base,
  });

  if (effectiveMergeIds.length === 0) return fail('blocks_missing');

  const chain = [input.primaryBlockId, ...effectiveMergeIds].map((id) => ctx.factsById.get(id));
  if (chain.some((facts) => facts === undefined)) return fail('blocks_missing');
  const blocks = chain as BlockMergeAdmissionFacts[];

  // Null structured content means there is NOTHING deterministic to evaluate
  // (no question numbers, no continuity evidence) — fail closed. The same
  // blocks would also soft-skip inside mergeQuestions (null_structured).
  if (blocks.some((b) => b.structured === null)) return fail('missing_continuity');

  // One ingestion session for the whole chain, equal to the declared one.
  const sessions = new Set(blocks.map((b) => b.ingestion_session_id));
  if (
    sessions.size !== 1 ||
    (input.ingestionSessionId !== undefined && !sessions.has(input.ingestionSessionId))
  ) {
    return fail('session_mismatch');
  }

  // One canonical source document that resolves to a real row.
  const docIds = new Set(blocks.map((b) => b.source_document_id));
  if (docIds.size !== 1) return fail('unknown_source');
  const docId = [...docIds][0];
  if (!docId || !ctx.knownDocumentIds.has(docId)) return fail('unknown_source');

  // Unambiguous page provenance: every block's stored page_spans must be a
  // strictly +1 integer sequence (non-integer / duplicated / out-of-order /
  // internally gapped spans cannot prove coverage), and the chain must not be
  // entirely the page-0 placeholder stamped by the docx/Tencent fallbacks.
  const provenRanges: Array<{ block: BlockMergeAdmissionFacts; min: number; max: number }> = [];
  for (const b of blocks) {
    const pages = contiguousPages(b);
    if (pages === null) return fail('ambiguous_page_index');
    provenRanges.push({ block: b, min: pages[0], max: pages[pages.length - 1] });
  }
  if (provenRanges.every((r) => r.min === 0)) return fail('ambiguous_page_index');

  // Ordered adjacent pages in the order mergeQuestions WILL MUTATE: the
  // primitive absorbs in caller mergeIds order (primary first, then each
  // listed id), so the proven chain is [primary, ...effectiveMergeIds] as
  // given — never re-sorted. Each next block must start exactly one page
  // after the previous block ends: same-page (gap 0), overlap, backward
  // order and real gaps all fail closed.
  for (let i = 1; i < provenRanges.length; i += 1) {
    if (provenRanges[i].min !== provenRanges[i - 1].max + 1) return fail('pages_not_adjacent');
  }

  // Continuity per adjacent pair in the same mutation order, with the
  // own-number veto first. An own number that does not continue the running
  // sub-sequence is a different question (conflicting). An own number the
  // parser cannot read proves neither conflict nor continuity — the merge
  // fails closed instead of treating unreadable as absent.
  for (let i = 1; i < provenRanges.length; i += 1) {
    const prev = provenRanges[i - 1].block;
    const next = provenRanges[i].block;
    const lead = leadingQuestionNo(next);
    if (lead === null) continue;
    if (lead.kind === 'unknown') return fail('missing_continuity');
    const trail = trailingQuestionNo(prev);
    if (!isSubContinuation(trail, lead)) return fail('conflicting_question_number');
  }

  return { eligible: true, reason: undefined, ...base };
}

// ---------------------------------------------------------------------------
// Batched fact loading — ONE question_block query + ONE source_document query
// per call (no per-row N+1); usable on Db or inside the mergeQuestions Tx.
// ---------------------------------------------------------------------------

export async function loadBlockMergeAdmissionContext(
  db: DbLike,
  blockIds: readonly string[],
): Promise<BlockMergeAdmissionContext> {
  const ids = [...new Set(blockIds)];
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: question_block.id,
            ingestion_session_id: question_block.ingestion_session_id,
            source_document_id: question_block.source_document_id,
            page_spans: question_block.page_spans,
            structured: question_block.structured,
          })
          .from(question_block)
          .where(inArray(question_block.id, ids));

  const docIds = [
    ...new Set(
      rows
        .map((row) => row.source_document_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const docs =
    docIds.length === 0
      ? []
      : await db
          .select({ id: source_document.id })
          .from(source_document)
          .where(inArray(source_document.id, docIds));

  return {
    factsById: new Map(rows.map((row) => [row.id, row])),
    knownDocumentIds: new Set(docs.map((doc) => doc.id)),
  };
}

/**
 * The shared admission gate: load stored facts and evaluate. Throws the typed
 * 409 `merge_inadmissible` when the merge is not provably safe, so every caller
 * (accept applier's preflight AND the locked in-transaction re-check) shares
 * one learner-facing failure shape.
 */
export async function assertBlockMergeAdmission(
  db: DbLike,
  input: BlockMergeAdmissionInput,
): Promise<BlockMergeAdmissionVerdict> {
  const ctx = await loadBlockMergeAdmissionContext(db, [
    input.primaryBlockId,
    ...input.mergeBlockIds,
  ]);
  const verdict = evaluateBlockMergeAdmission(input, ctx);
  if (!verdict.eligible) {
    throw new ApiError(
      'merge_inadmissible',
      '无法确认这些题块属于同一道题，已保留原样',
      409,
      undefined,
      { reason: verdict.reason, affected_block_count: verdict.affectedBlockCount },
    );
  }
  return verdict;
}
