// YUK-212 + YUK-484(B) — narrowQuestionToPart unit (no DB).
//
// The C1 proof lives here: the returned row's `structured` must contain ONLY the
// addressed sub (passage stem + that one sub), never the siblings — because
// semanticInput() passes question.structured into the model message verbatim, so
// a whole-row structured leaks every sibling sub to the semantic judge.

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { JudgeQuestionRow } from '@/server/ai/judges/question-contract';
import { describe, expect, it } from 'vitest';
import { narrowQuestionToPart } from './narrow-part';

// A two-part reading-comprehension stem: passage + two sub questions.
function compositeRow(): JudgeQuestionRow {
  const structured: StructuredQuestionT = {
    id: 'stem',
    role: 'stem',
    prompt_text: '阅读下文，回答问题。',
    sub_questions: [
      {
        id: 'p1',
        role: 'sub',
        question_no: '1',
        prompt_text: '第一问：作者的观点是什么？',
        answers: ['A'],
      },
      {
        id: 'p2',
        role: 'sub',
        question_no: '2',
        prompt_text: '第二问：本文的论证方法是什么？',
        answers: ['B'],
      },
    ],
  };
  return {
    id: 'q-composite',
    kind: 'short_answer',
    prompt_md:
      '阅读下文，回答问题。\n\n1. 第一问：作者的观点是什么？\n\n2. 第二问：本文的论证方法是什么？',
    reference_md: 'A\n\nB',
    rubric_json: null,
    choices_md: null,
    judge_kind_override: null,
    structured,
  };
}

// A standalone atomic question (no structured tree).
function atomicRow(): JudgeQuestionRow {
  return {
    id: 'q-atomic',
    kind: 'short_answer',
    prompt_md: '直接回答这道题。',
    reference_md: '答案',
    rubric_json: null,
    choices_md: null,
    judge_kind_override: null,
  };
}

describe('narrowQuestionToPart', () => {
  it('narrows to p1: prompt keeps passage + p1, drops p2; reference is p1 only', () => {
    const row = compositeRow();
    const narrowed = narrowQuestionToPart(row, 'p1');

    // prompt carries the passage AND p1, but NOT p2.
    expect(narrowed.prompt_md).toContain('阅读下文');
    expect(narrowed.prompt_md).toContain('第一问');
    expect(narrowed.prompt_md).not.toContain('第二问');
    // reference is p1's answer only (not p2's).
    expect(narrowed.reference_md).toBe('A');

    // C1 PROOF: the returned row's STRUCTURED subtree contains p1, NOT p2.
    // semanticInput() ships question.structured into the model message verbatim,
    // so this is what actually closes the sibling-leak.
    const subIds = (narrowed.structured?.sub_questions ?? []).map((s) => s.id);
    expect(subIds).toContain('p1');
    expect(subIds).not.toContain('p2');
    // The passage stem is preserved (its prompt_text), not just a bare sub.
    expect(narrowed.structured?.role).toBe('stem');
    expect(narrowed.structured?.prompt_text).toBe('阅读下文，回答问题。');
  });

  it('narrows to p2: mirror — keeps passage + p2, drops p1', () => {
    const row = compositeRow();
    const narrowed = narrowQuestionToPart(row, 'p2');

    expect(narrowed.prompt_md).toContain('阅读下文');
    expect(narrowed.prompt_md).toContain('第二问');
    expect(narrowed.prompt_md).not.toContain('第一问');
    expect(narrowed.reference_md).toBe('B');

    const subIds = (narrowed.structured?.sub_questions ?? []).map((s) => s.id);
    expect(subIds).toContain('p2');
    expect(subIds).not.toContain('p1');
  });

  it('passage-preservation: a passage-dependent sub still carries the stem passage', () => {
    const row = compositeRow();
    const narrowed = narrowQuestionToPart(row, 'p1');
    // The narrowed prompt for the passage-dependent sub MUST still carry the
    // stem passage so the judge has the reading context.
    expect(narrowed.prompt_md.startsWith('阅读下文')).toBe(true);
  });

  it('missing part_ref → returns input by reference (whole-row fallback)', () => {
    const row = compositeRow();
    expect(narrowQuestionToPart(row, 'missing')).toBe(row);
  });

  it('null part_ref → returns input by reference', () => {
    const row = atomicRow();
    expect(narrowQuestionToPart(row, null)).toBe(row);
  });

  it('undefined part_ref → returns input by reference', () => {
    const row = atomicRow();
    expect(narrowQuestionToPart(row, undefined)).toBe(row);
  });

  it('null structured → returns input by reference even with a part_ref', () => {
    const row = atomicRow(); // no structured field
    expect(narrowQuestionToPart(row, 'p1')).toBe(row);
  });

  it('standalone top-level node matched directly → narrows to itself (no parent stem)', () => {
    const structured: StructuredQuestionT = {
      id: 'solo',
      role: 'standalone',
      prompt_text: '独立题面。',
      answers: ['C'],
    };
    const row: JudgeQuestionRow = {
      id: 'q-solo',
      kind: 'short_answer',
      prompt_md: 'old',
      reference_md: 'old-ref',
      rubric_json: null,
      choices_md: null,
      judge_kind_override: null,
      structured,
    };
    const narrowed = narrowQuestionToPart(row, 'solo');
    expect(narrowed).not.toBe(row); // matched → a new row
    expect(narrowed.structured?.id).toBe('solo');
    expect(narrowed.reference_md).toBe('C');
  });

  it('answer-less sub → reference_md is empty, NOT the whole-row (no sibling leak via reference channel — C1)', () => {
    const structured: StructuredQuestionT = {
      id: 'stem',
      role: 'stem',
      prompt_text: '阅读下文。',
      sub_questions: [
        { id: 'p1', role: 'sub', prompt_text: '无答案的小题。' }, // no answers/analysis
        { id: 'p2', role: 'sub', prompt_text: '有答案的兄弟题。', answers: ['SIBLING-ANSWER-B'] },
      ],
    };
    const row: JudgeQuestionRow = {
      id: 'q-noanswer',
      kind: 'short_answer',
      prompt_md: 'old',
      // whole-row reference (derived from the full tree) contains the sibling's answer:
      reference_md: '答案：\n(2) SIBLING-ANSWER-B',
      rubric_json: null,
      choices_md: null,
      judge_kind_override: null,
      structured,
    };
    const narrowed = narrowQuestionToPart(row, 'p1');
    // The narrowed reference must NOT fall back to the whole-row reference (which
    // holds the sibling's answer) — that would re-open the C1 leak via reference_md.
    expect(narrowed.reference_md).not.toContain('SIBLING-ANSWER-B');
    expect(narrowed.reference_md).toBe('');
  });
});
