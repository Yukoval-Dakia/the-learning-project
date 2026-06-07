export interface JudgeInput {
  reference: string;
  // YUK-260: option texts for choice questions. When present, both answer and
  // reference are resolved letter↔text before comparison so a letter submission
  // ("A" / "BC") matches a reference stored as option text (and vice versa).
  // Optional/nullable ⇒ non-choice callers (incl. raw DB / JudgeQuestionRow rows
  // that carry choices_md: null) are unaffected — null is normalised to [].
  choices_md?: string[] | null;
}

export interface AnswerInput {
  content: string;
}

export interface JudgeResult {
  verdict: 'correct' | 'partial' | 'incorrect';
  score: number;
  feedback_md: string;
  evidence_json: Record<string, unknown>;
}
export type JudgeResultV1 = JudgeResult;

const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase();

export function judgeExact(question: JudgeInput, answer: AnswerInput): JudgeResult {
  // YUK-260: choice questions — the student UI submits the letter ("A", multi
  // "BC") while the reference may store option TEXT (or vice versa, depending on
  // the sourcing line). Resolve both sides to choice indices when possible and
  // compare as sets; fall back to plain text equality so non-choice exact
  // judging is unchanged. Kept isomorphic with the V2 capability judge in
  // src/core/capability/judges/exact.ts.
  const choices = question.choices_md ?? [];
  const resolveChoiceIndices = (value: string): number[] | null => {
    if (choices.length === 0) return null;
    const t = value.normalize('NFKC').trim();
    if (t.length === 0) return null;
    // `t` is already NFKC + trim; normalize(t) would only re-add toLowerCase.
    const tLower = t.toLowerCase();

    // (1) Exact option-text equality first — so an option whose text happens to
    // be pure Latin letters (e.g. ['True','False'], or a math option 'a + b')
    // matches by text rather than being mis-parsed as a letter index.
    const exact = choices.findIndex((c) => normalize(c) === tLower);
    if (exact !== -1) return [exact];

    // (2) Pure letter string(s): "A" / "BC" / "B、C". Only accept when every
    // resolved index is in range; otherwise fall through to prefix parsing.
    const lettersOnly = t.toUpperCase().replace(/[\s,，、和与]/g, '');
    if (/^[A-Z]+$/.test(lettersOnly)) {
      const idx = [...new Set(lettersOnly.split('').map((c) => c.charCodeAt(0) - 65))].sort(
        (a, b) => a - b,
      );
      if (idx.length > 0 && idx.every((i) => i < choices.length)) return idx;
    }

    // (3) Leading-letter prefix: reference_md per the reading-comprehension skill
    // is "正确项字母 + 依据" (e.g. "C。原文依据…"), and choices_md options may carry
    // a label prefix ("A. 修八尺有余…"). Parse the leading letter when followed by
    // a separator so 'C' answer ↔ "C。…" reference are judged equal.
    const prefix = t.toUpperCase().match(/^([A-Z])[\s.．。、,，:：)）]/);
    if (prefix) {
      const i = prefix[1].charCodeAt(0) - 65;
      if (i < choices.length) return [i];
    }

    return null;
  };
  const answerIdx = resolveChoiceIndices(answer.content);
  const referenceIdx = resolveChoiceIndices(question.reference);
  const choiceMatch =
    answerIdx !== null &&
    referenceIdx !== null &&
    answerIdx.length === referenceIdx.length &&
    answerIdx.every((v, i) => v === referenceIdx[i]);

  const match = choiceMatch || normalize(answer.content) === normalize(question.reference);
  // YUK-260 evidence: record HOW the match was decided plus resolved indices, so
  // a choice_index verdict (where normalized text legitimately differs) does not
  // read as self-contradictory. Kept isomorphic with the V2 capability judge.
  return {
    verdict: match ? 'correct' : 'incorrect',
    score: match ? 1 : 0,
    feedback_md: match
      ? `正确答案：${question.reference}。`
      : `参考答案：${question.reference}。你的答案：${answer.content}。`,
    evidence_json: {
      match,
      normalized_reference: normalize(question.reference),
      match_type: choiceMatch ? 'choice_index' : 'text',
      answer_choice_indices: answerIdx,
      reference_choice_indices: referenceIdx,
    },
  };
}
