// YUK-1404 — block_merge learner-admission proof. A merge proposal is only
// learner-visible / acceptable when the STORED question_block rows prove the
// merge joins one question, deterministically:
//
//   1. every block in the chain shares ONE ingestion_session_id (matching the
//      proposal's declared session),
//   2. every block shares ONE canonical source_document_id that resolves to a
//      real source_document row,
//   3. page facts are unambiguous: every block carries page_spans and the
//      chain is not all-placeholder (the docx/Tencent fallback paths stamp
//      page_index 0 on every block — an all-zero chain is provenance-less),
//   4. ordered adjacent pages: sorted by (min page, ordinal) the PRIMARY is
//      first and each next block starts within {prev.max, prev.max+1},
//   5. deterministic continuity evidence per adjacent pair: the next block
//      carries no own question number, OR the previous block visibly ends
//      mid-question, OR a same-style sub-numbering continues ((2) after (1)),
//      OR an option letter sequence continues — and NEVER a conflicting
//      question number for a different question (the decisive veto: any
//      top-level number, or a sub number that does not continue the sequence,
//      on the next block).
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
  ordinal: number;
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

const MID_QUESTION_TAIL_RE = /[，、；：:;,—–~～…\-－（([【「『“‘'"]$/u;
const MID_QUESTION_PHRASE_RE =
  /(?:如下|如下图|如图所示|如下图所示|如图|见图|见下表|如下所示|包括|分别是|待续|未完待续|接上页|续下页)$/u;

/** Does the block's trailing content visibly end mid-question? */
function endsMidQuestion(facts: BlockMergeAdmissionFacts): boolean {
  const root = facts.structured;
  if (!root) return false;
  const leaf = leavesOf(root).at(-1);
  if (!leaf) return false;
  const tail = (
    leaf.options && leaf.options.length > 0 ? leaf.options.at(-1)?.text : leaf.prompt_text
  )?.trimEnd();
  if (!tail) return leaf.options !== undefined && leaf.options.length > 0;
  if (MID_QUESTION_TAIL_RE.test(tail)) return true;
  if (MID_QUESTION_PHRASE_RE.test(tail)) return true;
  return false;
}

/** Prev ends with options …B and next's leading text starts with C. */
function continuesOptionSequence(
  prev: BlockMergeAdmissionFacts,
  next: BlockMergeAdmissionFacts,
): boolean {
  const prevLeaf = prev.structured ? leavesOf(prev.structured).at(-1) : undefined;
  const lastOption = prevLeaf?.options?.at(-1);
  if (lastOption?.label.length !== 1) return false;
  const lastCode = lastOption.label.toUpperCase().charCodeAt(0);
  if (lastCode < 65 || lastCode >= 90) return false; // A..Y only; 'Z' has no next letter
  const nextPrompt = next.structured ? leavesOf(next.structured)[0]?.prompt_text : undefined;
  const m = /^\s*([A-ZＡ-Ｚ])\s*[.、．:：]/u.exec(nextPrompt ?? '');
  if (!m) return false;
  const nextCode =
    m[1].charCodeAt(0) >= 0xff21 ? m[1].charCodeAt(0) - 0xff21 + 65 : m[1].charCodeAt(0);
  return nextCode === lastCode + 1;
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

  // Unambiguous page provenance: spans present on every block; the chain must
  // not be entirely the page-0 placeholder stamped by the docx/Tencent fallbacks.
  if (blocks.some((b) => b.page_spans.length === 0)) return fail('ambiguous_page_index');
  const ranges = blocks.map((b) => {
    const pages = b.page_spans.map((s) => s.page_index);
    return { block: b, min: Math.min(...pages), max: Math.max(...pages) };
  });
  if (ranges.every((r) => r.min === 0)) return fail('ambiguous_page_index');

  // Ordered adjacent pages: primary first by (min page, ordinal); each next
  // block starts on the previous block's last page or the immediately next one.
  const sorted = [...ranges].sort((a, b) => a.min - b.min || a.block.ordinal - b.block.ordinal);
  if (sorted[0].block.id !== input.primaryBlockId) return fail('pages_not_adjacent');
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].min - sorted[i - 1].max;
    if (gap < 0 || gap > 1) return fail('pages_not_adjacent');
  }

  // Continuity per adjacent pair, with the conflicting-number veto first.
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1].block;
    const next = sorted[i].block;
    const lead = leadingQuestionNo(next);
    const trail = trailingQuestionNo(prev);
    if (lead !== null && lead.kind !== 'unknown' && !isSubContinuation(trail, lead)) {
      return fail('conflicting_question_number');
    }
    const continuity =
      lead === null ||
      isSubContinuation(trail, lead) ||
      endsMidQuestion(prev) ||
      continuesOptionSequence(prev, next);
    if (!continuity) return fail('missing_continuity');
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
            ordinal: question_block.ordinal,
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
