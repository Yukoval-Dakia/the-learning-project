// YUK-1404 — block_merge learner-admission invariants. Irreversible-loss class
// (AGENTS.md invariant #1 + #3): the same deterministic proof gates the learner
// inbox read AND the accept path, so every branch must fail closed on the
// documented inputs — and never consult model confidence (no cutoff policy).

import { describe, expect, it } from 'vitest';

import {
  type BlockMergeAdmissionContext,
  type BlockMergeAdmissionFacts,
  type BlockMergeIneligibilityReason,
  evaluateBlockMergeAdmission,
  parseQuestionNo,
} from './block-merge-admission';

const DOC = 'doc-1';
const SESSION = 'sess-1';

let idSeq = 0;
function facts(overrides: Partial<BlockMergeAdmissionFacts> = {}): BlockMergeAdmissionFacts {
  idSeq += 1;
  const base: BlockMergeAdmissionFacts = {
    id: `b${idSeq}`,
    ingestion_session_id: SESSION,
    source_document_id: DOC,
    status: 'draft',
    page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    ordinal: idSeq - 1,
    source_asset_ids: [`asset-${Math.ceil(idSeq / 3)}`, 'asset-shared'],
    structured: { id: `n${idSeq}`, role: 'standalone', prompt_text: '题目内容。' },
  };
  return Object.assign(base, overrides);
}

function ctxFor(
  blocks: BlockMergeAdmissionFacts[],
  knownDocumentIds: readonly string[] = [DOC],
  sessionBlocks: BlockMergeAdmissionContext['sessionBlocks'] = new Map(),
): BlockMergeAdmissionContext {
  const resolved =
    sessionBlocks.size > 0
      ? sessionBlocks
      : new Map([
          [SESSION, blocks.map((b) => ({ id: b.id, ordinal: b.ordinal, status: b.status }))],
        ]);
  return {
    factsById: new Map(blocks.map((b) => [b.id, b])),
    knownDocumentIds: new Set(knownDocumentIds),
    sessionBlocks: resolved,
  };
}

function input(
  primary: BlockMergeAdmissionFacts,
  members: BlockMergeAdmissionFacts[],
  ingestionSessionId = SESSION,
) {
  return {
    primaryBlockId: primary.id,
    mergeBlockIds: members.map((b) => b.id),
    ingestionSessionId,
  };
}

function expectIneligible(
  blocks: BlockMergeAdmissionFacts[],
  mergeIds: string[],
  reason: BlockMergeIneligibilityReason,
  ctx = ctxFor(blocks),
  primaryBlockId = blocks[0].id,
) {
  const verdict = evaluateBlockMergeAdmission(
    { primaryBlockId, mergeBlockIds: mergeIds, ingestionSessionId: SESSION },
    ctx,
  );
  expect(verdict.eligible).toBe(false);
  expect(verdict.reason).toBe(reason);
}

describe('evaluateBlockMergeAdmission', () => {
  it('admits an adjacent unnumbered fragment continuing the question', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 3, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const verdict = evaluateBlockMergeAdmission(
      input(primary, [member]),
      ctxFor([primary, member]),
    );
    expect(verdict.eligible).toBe(true);
    expect(verdict.affectedBlockCount).toBe(2);
    expect(verdict.effectiveMergeIds).toEqual([member.id]);
  });

  it('admits a three-block chain listed in strict page order', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const m2 = facts({
      id: 'm2',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const m3 = facts({
      id: 'm3',
      page_spans: [{ page_index: 3, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const verdict = evaluateBlockMergeAdmission(
      input(primary, [m2, m3]),
      ctxFor([primary, m2, m3]),
    );
    expect(verdict).toMatchObject({ eligible: true, affectedBlockCount: 3 });
    expect(verdict.effectiveMergeIds).toEqual([m2.id, m3.id]);
  });

  // @invariant data: a single photographed page must not leave one question split into two blocks
  // @fails-if the same-page arm disappears or stops admitting bare fragments on contiguous ordinals
  it('admits a same-page bare fragment continuing the question', () => {
    // One photographed page can split a question's trailing text into a second
    // block; an unnumbered bare fragment right after it in reading order is the
    // continuation, proven by contiguous ordinals instead of page adjacency.
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 4, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 4, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const verdict = evaluateBlockMergeAdmission(
      input(primary, [member]),
      ctxFor([primary, member]),
    );
    expect(verdict.eligible).toBe(true);
  });

  // @invariant data: one-photo sessions (placeholder page 0) still merge a proven continuation
  // @fails-if the page-0 ambiguity gate stops trusting a shared single source asset
  it('admits a same-page fragment on a single-asset (one-photo) session', () => {
    const primary = facts({
      id: 'p',
      source_asset_ids: ['asset-1'],
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      source_asset_ids: ['asset-1'],
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const verdict = evaluateBlockMergeAdmission(
      input(primary, [member]),
      ctxFor([primary, member]),
    );
    expect(verdict.eligible).toBe(true);
  });

  // @invariant data: two distinct printed questions on one page must never be merged
  // @fails-if the same-page arm admits a follower that carries its own question number
  it('rejects a same-page block carrying an own number (a different question)', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      source_asset_ids: ['asset-1'],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      source_asset_ids: ['asset-1'],
      structured: { id: 'n', role: 'standalone', question_no: '2', prompt_text: '第二题。' },
    });
    expectIneligible([primary, member], [member.id], 'conflicting_question_number');
  });

  // @invariant data: a numberless but self-contained block must not be absorbed into a neighbour
  // @fails-if the same-page arm merges a follower that still carries options/answers/analysis
  it('rejects a same-page follower that could stand alone as a question', () => {
    // A numberless block with its own options/answers is not a bare fragment —
    // it may be a whole question that merely lost its printed number.
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      source_asset_ids: ['asset-1'],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      source_asset_ids: ['asset-1'],
      structured: {
        id: 'n',
        role: 'standalone',
        prompt_text: '完整的一道题。',
        options: [
          { label: 'A', text: '甲' },
          { label: 'B', text: '乙' },
        ],
      },
    });
    expectIneligible([primary, member], [member.id], 'missing_continuity');
  });

  // @invariant data: merging across a live block would splice unrelated question content
  // @fails-if the same-page arm skips the intervening-live-block check on session ordinals
  it('rejects a same-page pair with a live block between their ordinals', () => {
    const primary = facts({
      id: 'p',
      ordinal: 0,
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      source_asset_ids: ['asset-1'],
    });
    const member = facts({
      id: 'm',
      ordinal: 2,
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      source_asset_ids: ['asset-1'],
    });
    const between = facts({ id: 'x', ordinal: 1, source_asset_ids: ['asset-1'] });
    const ctx = ctxFor(
      [primary, member],
      [DOC],
      new Map([
        [
          SESSION,
          [primary, between, member].map((b) => ({
            id: b.id,
            ordinal: b.ordinal,
            status: b.status,
          })),
        ],
      ]),
    );
    const verdict = evaluateBlockMergeAdmission(input(primary, [member]), ctx);
    expect(verdict).toMatchObject({ eligible: false, reason: 'pages_not_adjacent' });
  });

  it('rejects a reversed payload chain (sorted adjacency cannot rescue mutation order)', () => {
    // mergeQuestions absorbs in the payload's mergeIds order: a [page3, page2]
    // payload would garble the absorbed sub-question order irreversibly, so
    // the proof binds the given order — 1 → 3 is not adjacent.
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const m3 = facts({
      id: 'm3',
      page_spans: [{ page_index: 3, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const m2 = facts({
      id: 'm2',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const verdict = evaluateBlockMergeAdmission(
      input(primary, [m3, m2]),
      ctxFor([primary, m3, m2]),
    );
    expect(verdict).toMatchObject({ eligible: false, reason: 'pages_not_adjacent' });
    // The reported effective set preserves the payload order mergeQuestions
    // would mutate (dedup + primary-strip only — never re-sorted).
    expect(verdict.effectiveMergeIds).toEqual([m3.id, m2.id]);
  });

  it('rejects overlapping and backward page ranges', () => {
    // The member's first page must be exactly prev.max+1 — starting inside or
    // before the primary's span is not adjacency.
    const primary = facts({
      id: 'p',
      page_spans: [
        { page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } },
        { page_index: 3, bbox: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 3, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible([primary, member], [member.id], 'pages_not_adjacent');
  });

  it('rejects ambiguous intra-block span sets', () => {
    // Unprovable coverage: internal gap, out-of-order, duplicated and
    // non-integer page indices all fail as ambiguous provenance.
    const span = (page_index: number) => ({
      page_index,
      bbox: { x: 0, y: 0, width: 1, height: 1 },
    });
    const cases = [[span(1), span(3)], [span(3), span(1)], [span(2), span(2)], [span(1.5)]];
    for (const spans of cases) {
      const primary = facts({ id: 'p', page_spans: [span(1)] });
      const member = facts({ id: 'm', page_spans: spans });
      expectIneligible([primary, member], [member.id], 'ambiguous_page_index');
    }
  });

  it('admits sub-numbering continuation (2) after (1) across pages', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: {
        id: 's',
        role: 'stem',
        prompt_text: '阅读材料，回答问题。',
        sub_questions: [{ id: 's1', role: 'sub', question_no: '(1)', prompt_text: '第一小问。' }],
      },
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 3, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 'n', role: 'standalone', question_no: '(2)', prompt_text: '第二小问。' },
    });
    expect(
      evaluateBlockMergeAdmission(input(primary, [member]), ctxFor([primary, member])).eligible,
    ).toBe(true);
  });

  it('rejects an unparseable own number even when the primary visibly ends mid-question', () => {
    // '5-6' is an OWN number the parser cannot read — not "no number": it can
    // prove neither conflict nor continuity, so the pair fails closed.
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 's', role: 'standalone', prompt_text: '已知函数图像如下：' },
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 'n', role: 'standalone', question_no: '5-6', prompt_text: '……' },
    });
    expectIneligible([primary, member], [member.id], 'missing_continuity');
  });

  it('admits an options fragment carrying no own number (options split across blocks)', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: {
        id: 's',
        role: 'standalone',
        prompt_text: '选择正确答案。',
        options: [
          { label: 'A', text: '甲' },
          { label: 'B', text: '乙' },
        ],
      },
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: {
        id: 'n',
        role: 'standalone',
        prompt_text: 'C. 丙\nD. 丁',
      },
    });
    expect(
      evaluateBlockMergeAdmission(input(primary, [member]), ctxFor([primary, member])).eligible,
    ).toBe(true);
  });

  it('rejects a conflicting same question number (the multi-paper crash case)', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 's', role: 'standalone', question_no: '1', prompt_text: '第1题。' },
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: {
        id: 'n',
        role: 'standalone',
        question_no: '1',
        prompt_text: '第1题（另一卷）。',
      },
    });
    expectIneligible([primary, member], [member.id], 'conflicting_question_number');
  });

  it('rejects ANY top-level own number on the next block (different or same)', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 's', role: 'standalone', question_no: '5', prompt_text: 'q5。' },
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 'n', role: 'standalone', question_no: '6', prompt_text: 'q6。' },
    });
    expectIneligible([primary, member], [member.id], 'conflicting_question_number');
  });

  it('rejects a conflicting number visible only in the prompt head (question_no absent)', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 's', role: 'standalone', prompt_text: '题干完整。' },
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 'n', role: 'standalone', prompt_text: '第2题 计算下列各式。' },
    });
    expectIneligible([primary, member], [member.id], 'conflicting_question_number');
  });

  // @invariant data: a decimal-leading fragment carries no own number, an inline enumeration fails closed, a real printed head still vetoes
  // @fails-if the shared head parser re-arms the decimal veto or admits a 「（1）（2）」 enumeration as a proven number
  it('treats decimal heads as numberless but fails closed on inline enumerations', () => {
    const rows = [
      { in: '3.14×2 等于多少？', eligible: true, reason: undefined },
      { in: '0.75 化成分数是____', eligible: true, reason: undefined },
      {
        in: '（1）求 x 的值；（2）求 y 的值',
        eligible: false,
        reason: 'missing_continuity' as const,
      },
      {
        in: '3. 计算下列各式。',
        eligible: false,
        reason: 'conflicting_question_number' as const,
      },
    ];
    for (const row of rows) {
      const primary = facts({
        id: 'p',
        ordinal: 0,
        page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
        source_asset_ids: ['asset-1'],
      });
      const member = facts({
        id: 'm',
        ordinal: 1,
        page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
        source_asset_ids: ['asset-1'],
        structured: { id: 'nm', role: 'standalone', prompt_text: row.in },
      });
      const verdict = evaluateBlockMergeAdmission(
        { primaryBlockId: 'p', mergeBlockIds: [member.id], ingestionSessionId: SESSION },
        ctxFor([primary, member]),
      );
      expect(verdict.eligible).toBe(row.eligible);
      expect(verdict.reason).toBe(row.reason);
    }
  });

  it('rejects a stem fragment starting a fresh sub sequence (new question)', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: {
        id: 's',
        role: 'stem',
        prompt_text: '阅读材料一。',
        sub_questions: [{ id: 's1', role: 'sub', question_no: '(1)', prompt_text: 'sub1' }],
      },
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: {
        id: 'n',
        role: 'stem',
        prompt_text: '阅读材料二。',
        sub_questions: [{ id: 'n1', role: 'sub', question_no: '(1)', prompt_text: 'sub1' }],
      },
    });
    expectIneligible([primary, member], [member.id], 'conflicting_question_number');
  });

  it('rejects a page gap (non-adjacent pages)', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 4, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible([primary, member], [member.id], 'pages_not_adjacent');
  });

  it('rejects when a member precedes the primary in source order', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 3, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible([primary, member], [member.id], 'pages_not_adjacent');
  });

  it('rejects the all-placeholder page-0 chain (docx/Tencent fallback provenance)', () => {
    const primary = facts({ id: 'p' });
    const member = facts({ id: 'm' });
    expectIneligible([primary, member], [member.id], 'ambiguous_page_index');
  });

  it('rejects a block with empty page_spans', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({ id: 'm', page_spans: [] });
    expectIneligible([primary, member], [member.id], 'ambiguous_page_index');
  });

  it('rejects null / empty / missing source_document_id', () => {
    const primary = facts({
      id: 'p',
      source_document_id: null,
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      source_document_id: null,
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible([primary, member], [member.id], 'unknown_source');
  });

  it('rejects different source_document_ids across the chain', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      source_document_id: 'doc-2',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible(
      [primary, member],
      [member.id],
      'unknown_source',
      ctxFor([primary, member], [DOC, 'doc-2']),
    );
  });

  it('rejects a source document row that no longer exists', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible(
      [primary, member],
      [member.id],
      'unknown_source',
      ctxFor([primary, member], []),
    );
  });

  it('rejects cross-session chains and a mismatched declared session', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      ingestion_session_id: 'sess-2',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible([primary, member], [member.id], 'session_mismatch');

    const member2 = facts({
      id: 'm2',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const verdict = evaluateBlockMergeAdmission(
      {
        primaryBlockId: primary.id,
        mergeBlockIds: [member2.id],
        ingestionSessionId: 'sess-other',
      },
      ctxFor([primary, member2]),
    );
    expect(verdict).toMatchObject({ eligible: false, reason: 'session_mismatch' });
  });

  it('rejects a referenced block that no longer exists', () => {
    const primary = facts({ id: 'p' });
    expectIneligible([primary], ['ghost-block'], 'blocks_missing');
  });

  it('rejects a degenerate proposal whose merge ids all resolve to the primary', () => {
    const primary = facts({ id: 'p' });
    expectIneligible([primary], [primary.id, primary.id], 'blocks_missing');
  });

  it('rejects an unparseable next number without mid-question evidence', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 's', role: 'standalone', prompt_text: '题目完整。' },
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 'n', role: 'standalone', question_no: 'Q-3', prompt_text: '……' },
    });
    expectIneligible([primary, member], [member.id], 'missing_continuity');
  });

  it('rejects null structured content anywhere in the chain', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: null,
    });
    expectIneligible([primary, member], [member.id], 'missing_continuity');
  });

  // YUK-1404 stale arm — a referenced block that already left draft can never
  // be re-merged: the proposal is stale (world state changed), and the accept
  // lane must be able to branch on exactly this reason to answer softly, so
  // the reason identity is load-bearing, not cosmetic.
  it('rejects with not_draft when a merge block already left draft', () => {
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      status: 'imported',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible([primary, member], [member.id], 'not_draft');
  });

  it('rejects with not_draft when the primary itself already left draft', () => {
    const primary = facts({
      id: 'p',
      status: 'merged',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const member = facts({
      id: 'm',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expectIneligible([primary, member], [member.id], 'not_draft');
  });

  it('not_draft dominates proof failures on the same chain (stale answer wins)', () => {
    // A non-draft member that ALSO carries a conflicting own number must
    // answer not_draft: the accept lane's stale branch keys on this reason,
    // and a merged/imported block is unmergeable regardless of proof quality.
    const primary = facts({
      id: 'p',
      page_spans: [{ page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 's', role: 'standalone', question_no: '5', prompt_text: '题目' },
    });
    const member = facts({
      id: 'm',
      status: 'imported',
      page_spans: [{ page_index: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { id: 'n', role: 'standalone', question_no: '6', prompt_text: '……' },
    });
    expectIneligible([primary, member], [member.id], 'not_draft');
  });
});

describe('parseQuestionNo', () => {
  it('classifies top-level and sub numbering forms', () => {
    expect(parseQuestionNo('5')).toEqual({ kind: 'top', value: 5, style: 'digits' });
    expect(parseQuestionNo('第3题')).toEqual({ kind: 'top', value: 3, style: 'prefixed' });
    expect(parseQuestionNo('(2)')).toEqual({ kind: 'sub', value: 2, style: 'paren' });
    expect(parseQuestionNo('（2）')).toEqual({ kind: 'sub', value: 2, style: 'paren' });
    expect(parseQuestionNo('2)')).toEqual({ kind: 'sub', value: 2, style: 'suffix' });
    expect(parseQuestionNo('③')).toEqual({ kind: 'sub', value: 3, style: 'circled' });
    expect(parseQuestionNo('(b)')).toEqual({ kind: 'sub', value: 2, style: 'letter' });
    expect(parseQuestionNo('十二')).toEqual({ kind: 'top', value: 12, style: 'cn' });
    expect(parseQuestionNo('')).toBeNull();
    expect(parseQuestionNo('  ')).toBeNull();
  });
});
