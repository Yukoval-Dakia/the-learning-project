export interface JudgeInput {
  reference: string;
  // YUK-260: option texts for choice questions. When present, both answer and
  // reference are resolved letter↔text before comparison so a letter submission
  // ("A" / "BC") matches a reference stored as option text (and vice versa).
  // Optional ⇒ non-choice callers are unaffected.
  choices_md?: string[];
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
    const lettersOnly = t.toUpperCase().replace(/[\s,，、和与]/g, '');
    if (/^[A-Z]+$/.test(lettersOnly)) {
      const idx = [...new Set(lettersOnly.split('').map((c) => c.charCodeAt(0) - 65))].sort(
        (a, b) => a - b,
      );
      if (idx.every((i) => i < choices.length)) return idx;
      return null;
    }
    const found = choices.findIndex((c) => normalize(c) === normalize(t));
    return found === -1 ? null : [found];
  };
  const answerIdx = resolveChoiceIndices(answer.content);
  const referenceIdx = resolveChoiceIndices(question.reference);
  const choiceMatch =
    answerIdx !== null &&
    referenceIdx !== null &&
    answerIdx.length === referenceIdx.length &&
    answerIdx.every((v, i) => v === referenceIdx[i]);

  const match = choiceMatch || normalize(answer.content) === normalize(question.reference);
  return {
    verdict: match ? 'correct' : 'incorrect',
    score: match ? 1 : 0,
    feedback_md: match
      ? `正确答案：${question.reference}。`
      : `参考答案：${question.reference}。你的答案：${answer.content}。`,
    evidence_json: { match, normalized_reference: normalize(question.reference) },
  };
}
