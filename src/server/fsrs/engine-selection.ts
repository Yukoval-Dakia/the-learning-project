import { z } from 'zod';

const EngineSelection = z.enum(['fsrs', 'forgetting_candidate']);
/** Default remains FSRS until the separate TEST T1–T6 acceptance gate. */
export function selectedForgettingEngine() {
  return EngineSelection.parse(process.env.FORGETTING_ENGINE ?? 'fsrs');
}
