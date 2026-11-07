// When a captured question's recorded confidence reads as low. A label, never a gate: such a question
// still enters the bank, and still has to pass admission before it can be practised. The 0.85 is
// carried over from the retired auto-enroll threshold; YUK-1667 sets the real level.
const LOW_JUDGE_CONFIDENCE = 0.85;

export function isLowJudgeConfidence(confidence: number | null | undefined): boolean {
  return confidence !== null && confidence !== undefined && confidence < LOW_JUDGE_CONFIDENCE;
}
