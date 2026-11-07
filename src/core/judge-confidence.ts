// When a captured question's recorded confidence reads as low. A label, never a gate: such a question
// still enters the bank, and still has to pass admission before it can be practised.
const LOW_JUDGE_CONFIDENCE = 0.85;

export function isLowJudgeConfidence(confidence: number | null | undefined): boolean {
  return confidence !== null && confidence !== undefined && confidence < LOW_JUDGE_CONFIDENCE;
}
