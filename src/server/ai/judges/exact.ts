export interface JudgeInput {
  reference: string;
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

export function judgeExact(question: JudgeInput, answer: AnswerInput): JudgeResult {
  const normalize = (s: string) => s.trim().toLowerCase();
  const match = normalize(answer.content) === normalize(question.reference);
  return {
    verdict: match ? 'correct' : 'incorrect',
    score: match ? 1 : 0,
    feedback_md: match
      ? `正确答案：${question.reference}。`
      : `参考答案：${question.reference}。你的答案：${answer.content}。`,
    evidence_json: { match, normalized_reference: normalize(question.reference) },
  };
}
