// block_merge admission proof: a merge is learner-visible/acceptable only when the
// stored question_block rows prove it joins one question:
//
//   1. all blocks share one ingestion_session_id matching the proposal;
//   2. all share one canonical source_document_id that resolves to a real row;
//   3. every block is still draft — one that left draft makes the proposal stale,
//      which the accept applier answers softly rather than with the typed 409;
//   4. page facts are unambiguous: page_spans form a strict +1 sequence in stored
//      order, and the chain is not entirely the page-0 placeholder stamped by the
//      docx/Tencent fallbacks. A chain entirely on one page is provable only
//      when its page is unambiguous (one shared source asset for page 0), and
//      then reads adjacency from stored ordinals instead;
//   5. adjacent pages follow the order mergeQuestions will mutate (caller mergeIds
//      order, never re-sorted), each next block starting at prev.max + 1. For a
//      same-page chain, ordinals must be strictly increasing and contiguous
//      among the session's live blocks;
//   6. each adjacent pair has deterministic continuity: the next block has no own
//      question number, or a same-style sub-number continues by one — and on one
//      page, even a sub-number continuation is not enough; the follower must
//      carry no own number at all. A conflicting number fails closed, and an
//      unreadable own number is not treated as absent.
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
  /** 0-based reading order inside the session — proves same-page adjacency. */
  ordinal: number;
  /** Source assets the block was cut from; one shared asset proves a one-page session. */
  source_asset_ids: string[];
  structured: StructuredQuestionT | null;
}

export interface BlockMergeAdmissionContext {
  factsById: ReadonlyMap<string, BlockMergeAdmissionFacts>;
  /** source_document ids that actually resolve (unknown docs fail closed). */
  knownDocumentIds: ReadonlySet<string>;
  /**
   * Every block's reading order in the chain's session(s), including non-draft
   * rows — proves no live block sits between two same-page chain members.
   */
  sessionBlocks: ReadonlyMap<
    string,
    ReadonlyArray<{ id: string; ordinal: number; status: string }>
  >;
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

export type ParsedQuestionNo =
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

/**
 * A printed question-number head: 第N题 / N. / （N）/ N). The dotted form
 * requires a digit NOT to follow the punctuation — `0.75`, `3.14×2`, `12.5 米`
 * are decimals inside the stem, not numbers, in both ASCII and full-width
 * digits. The dotted form also requires non-space content after it.
 */
const PROMPT_HEAD_QUESTION_NO_RE =
  /^\s*(?:第\s*(?:\d+|[零一二三四五六七八九十百两]+)\s*题|\d{1,3}\s*[.、．](?![0-9０-９])(?=\s*\S)|[（(]\s*\d{1,3}\s*[)）]|\d{1,3}\s*[)）])/u;

/**
 * Another paren-family number token later in the stem, anchored on a
 * separator (sentence punctuation / whitespace / start) so function-style
 * `f(2)` or prose references like 「由（2）式」 do not count — a head paren
 * number followed by one is an inline enumeration like 「（1）…；（2）…」.
 */
const INLINE_ENUM_NEXT_NO_RE =
  /(?:^|[\s；;，,、。:：])(?:[（(]\s*\d{1,3}\s*[)）]|\d{1,3}\s*[)）])/u;

export type PromptHeadQuestionNoMatch = {
  /**
   * The parsed head number; `{ kind: 'unknown' }` when a paren-family head is
   * really an inline enumeration like 「（1）…（2）…」 — not a movable own
   * number and not proof of its absence, so both callers stay conservative.
   */
  parsed: ParsedQuestionNo;
  /** Characters consumed by the head token, leading whitespace included. */
  matchLength: number;
};

/**
 * The single parser for a printed question number leading prompt text, shared
 * by the structure move (which relocates it into question_no) and merge
 * admission (which reads it as the block's own number).
 */
export function matchPromptHeadQuestionNo(
  promptText: string | null | undefined,
): PromptHeadQuestionNoMatch | null {
  const m = PROMPT_HEAD_QUESTION_NO_RE.exec(promptText ?? '');
  if (!m) return null;
  const head = m[0];
  const rest = (promptText ?? '').slice(head.length);
  if (/[)）]\s*$/u.test(head) && INLINE_ENUM_NEXT_NO_RE.test(rest)) {
    return { parsed: { kind: 'unknown' }, matchLength: head.length };
  }
  return { parsed: parseQuestionNo(head) ?? { kind: 'unknown' }, matchLength: head.length };
}

/** A visible question number leading the prompt text (question_no absent). */
function promptHeadQuestionNo(promptText: string | undefined): ParsedQuestionNo | null {
  return matchPromptHeadQuestionNo(promptText)?.parsed ?? null;
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
  // One photographed page can still split a question into adjacent fragments.
  // The cross-page proof below cannot see that (page facts are degenerate), so
  // a same-page chain proves adjacency from stored reading order instead, and
  // proves continuity more strictly: the follower must carry no own number at
  // all — two numbered blocks on one page are provably different questions.
  const samePage = provenRanges.every((r) => r.min === r.max && r.min === provenRanges[0].min);
  if (samePage) {
    const page = provenRanges[0].min;
    const sharedAssets = new Set(blocks.flatMap((b) => b.source_asset_ids));
    // Page-0 spans on a multi-asset chain cannot be told from the docx/Tencent
    // placeholder stamp, and a page >0 needs more than one asset to exist.
    if (page === 0 ? sharedAssets.size !== 1 : sharedAssets.size < 2) {
      return fail('ambiguous_page_index');
    }
    const chainIds = new Set(blocks.map((b) => b.id));
    const siblings = ctx.sessionBlocks.get(blocks[0].ingestion_session_id) ?? [];
    for (let i = 1; i < blocks.length; i += 1) {
      const prev = blocks[i - 1];
      const next = blocks[i];
      if (next.ordinal <= prev.ordinal) return fail('pages_not_adjacent');
      const interrupted = siblings.some(
        (b) =>
          !chainIds.has(b.id) &&
          b.status !== 'ignored' &&
          b.ordinal > prev.ordinal &&
          b.ordinal < next.ordinal,
      );
      if (interrupted) return fail('pages_not_adjacent');
      const lead = leadingQuestionNo(next);
      if (lead !== null) {
        return fail(lead.kind === 'unknown' ? 'missing_continuity' : 'conflicting_question_number');
      }
      // A numberless block can still be a whole question that merely lost its
      // printed number (a real extraction failure mode), so the follower must
      // be a bare text fragment — own options/answers/analysis/sub-questions
      // would make it a different question and fail closed.
      const root = next.structured;
      if (
        root === null ||
        (root.options?.length ?? 0) > 0 ||
        (root.answers?.length ?? 0) > 0 ||
        (root.analysis?.length ?? 0) > 0 ||
        (root.sub_questions?.length ?? 0) > 0
      ) {
        return fail('missing_continuity');
      }
    }
    return { eligible: true, reason: undefined, ...base };
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
            ordinal: question_block.ordinal,
            source_asset_ids: question_block.source_asset_ids,
            structured: question_block.structured,
          })
          .from(question_block)
          .where(inArray(question_block.id, ids));

  const sessionBlocks = new Map<string, Array<{ id: string; ordinal: number; status: string }>>();
  const sessionIds = [...new Set(rows.map((row) => row.ingestion_session_id))];
  if (sessionIds.length > 0) {
    const siblings = await db
      .select({
        id: question_block.id,
        ingestion_session_id: question_block.ingestion_session_id,
        ordinal: question_block.ordinal,
        status: question_block.status,
      })
      .from(question_block)
      .where(inArray(question_block.ingestion_session_id, sessionIds));
    for (const row of siblings) {
      const list = sessionBlocks.get(row.ingestion_session_id) ?? [];
      list.push({ id: row.id, ordinal: row.ordinal, status: row.status });
      sessionBlocks.set(row.ingestion_session_id, list);
    }
  }

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
    sessionBlocks,
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
