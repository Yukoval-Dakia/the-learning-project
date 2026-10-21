// block_merge admission proof: a merge is learner-visible/acceptable only when the
// stored question_block rows prove it joins one question:
//
//   1. all blocks share one ingestion_session_id matching the proposal;
//   2. all share one canonical source_document_id that resolves to a real row;
//   3. every block is still draft — one that left draft makes the proposal stale,
//      which the accept applier answers softly rather than with the typed 409;
//   4. page facts are unambiguous: page_spans form a strict +1 sequence in stored
//      order, and the chain is not entirely the page-0 placeholder stamped by the
//      docx/Tencent fallbacks;
//   5. adjacent pages follow the order mergeQuestions will mutate (caller mergeIds
//      order, never re-sorted), each next block starting at prev.max + 1;
//   6. each adjacent pair has deterministic continuity: the next block has no own
//      question number, or a same-style sub-number continues by one. A conflicting
//      own number fails closed, and an unreadable own number is not treated as
//      absent.
//
// Check the draft arm before the proof arms so a chain that is both non-draft and
// proof-deficient reports stale. Fail closed on every unknown; model confidence,
// reasons, and continuity_signal are AI evidence, not proof.
//
// The same rule runs at three seams so reads and writes cannot drift: inbox
// projection, the accept applier preflight, and mergeQuestions' locked
// in-transaction re-check.

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
  /** Stored lifecycle status — only 'draft' blocks are still mergeable. */
  status: string;
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
  /** a referenced block left draft; the proposal is stale, answered softly rather than with 409 */
  | 'not_draft'
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

/** A page_spans list proves contiguous pages only as a strict +1 integer sequence. */
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

  // Stale check runs before every proof arm so it dominates mixed failures,
  // mirroring mergeQuestions' draft-first guard.
  if (blocks.some((b) => b.status !== 'draft')) return fail('not_draft');

  // Nothing deterministic to evaluate; mergeQuestions would soft-skip these rows.
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

  // Unambiguous page provenance: strict +1 spans per block, and not an all-zero
  // placeholder chain.
  const provenRanges: Array<{ block: BlockMergeAdmissionFacts; min: number; max: number }> = [];
  for (const b of blocks) {
    const pages = contiguousPages(b);
    if (pages === null) return fail('ambiguous_page_index');
    provenRanges.push({ block: b, min: pages[0], max: pages[pages.length - 1] });
  }
  if (provenRanges.every((r) => r.min === 0)) return fail('ambiguous_page_index');

  // Pages follow the mutation order, each block starting exactly one page after
  // the previous ends. Gaps, overlap, same page, and backward order fail closed.
  for (let i = 1; i < provenRanges.length; i += 1) {
    if (provenRanges[i].min !== provenRanges[i - 1].max + 1) return fail('pages_not_adjacent');
  }

  // Continuity per adjacent pair, own-number veto first. A conflicting number is a
  // different question; an unreadable one proves neither conflict nor continuity.
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
// One question_block query and one source_document query per call; works on Db or
// inside the merge Tx.
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
            status: question_block.status,
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

/** The shared 409 for an ineligible verdict, so the learner-facing shape cannot drift. */
export function blockMergeAdmissionError(verdict: BlockMergeAdmissionVerdict): ApiError {
  return new ApiError(
    'merge_inadmissible',
    '无法确认这些题块属于同一道题，已保留原样',
    409,
    undefined,
    { reason: verdict.reason, affected_block_count: verdict.affectedBlockCount },
  );
}

/**
 * Load stored facts and evaluate; throws the shared 409 when the merge is not
 * provably safe. The not_draft arm also throws here: each caller decides whether
 * its lane answers that arm softly.
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
    throw blockMergeAdmissionError(verdict);
  }
  return verdict;
}
