import {
  compareLegacyExactAnswer,
  foldLegacyExactAnswer,
} from '@/core/schema/assessment/answer-compare';

export interface JudgeInput {
  reference: string;
  // option texts for choice questions. When present, both answer and
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

export function judgeExact(question: JudgeInput, answer: AnswerInput): JudgeResult {
  // 比较本身归 answer-compare（与 V2 exact judge 同一实现）：选项字母↔选项
  // 文本、答案头、过程作答的明示终态。V1 没有 pending/unsupported 语义：
  // 过程文本仍回落 incorrect，但 evidence 如实标注 process_answer_unresolvable —
  // 消费面（calibration 对照）能据此区分"真错"与"exact 判不动"。
  const comparison = compareLegacyExactAnswer({
    reference: question.reference,
    answer: answer.content,
    choices: question.choices_md ?? [],
  });
  const finalAnswer = comparison.finalAnswer;
  return {
    verdict: comparison.match ? 'correct' : 'incorrect',
    score: comparison.match ? 1 : 0,
    feedback_md: comparison.match
      ? `正确答案：${question.reference}。`
      : `参考答案：${question.reference}。你的答案：${answer.content}。`,
    evidence_json: {
      match: comparison.match,
      normalized_reference: foldLegacyExactAnswer(question.reference),
      // when either side embedded an explanation tail the compare ran
      // on extracted heads — record them, otherwise a stripped verdict reads
      // self-contradictory (normalized texts visibly differ).
      ...(comparison.answerHead !== answer.content.normalize('NFKC').trim()
        ? { answer_head: comparison.answerHead }
        : {}),
      ...(comparison.referenceHead !== question.reference.normalize('NFKC').trim()
        ? { reference_answer_head: comparison.referenceHead }
        : {}),
      ...(finalAnswer?.kind === 'found'
        ? { final_answer: { value: finalAnswer.values[0] ?? '', marker: finalAnswer.marker } }
        : {}),
      ...(comparison.processUnresolvable ? { process_answer_unresolvable: true } : {}),
      match_type: comparison.matchType,
      answer_choice_indices: comparison.answerChoiceIndices,
      reference_choice_indices: comparison.referenceChoiceIndices,
    },
  };
}
