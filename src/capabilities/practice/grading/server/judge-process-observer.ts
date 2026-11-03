/** Disabled in production. Process fixtures pause after real committed boundaries and retain their DB/wire evidence. */
export type JudgeProcessObservation = {
  kind: 'native-load-committed' | 'candidate-sealed' | 'claim-committed' | 'result-committed';
  submissionId: string;
  unitId?: string;
};
let observer: ((event: JudgeProcessObservation) => Promise<void>) | undefined;
export function setJudgeProcessObserverForTests(value: typeof observer) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Judge process observer is test-only');
  observer = value;
}
export async function observeJudgeProcess(event: JudgeProcessObservation) {
  if (process.env.NODE_ENV === 'test') await observer?.(event);
}
