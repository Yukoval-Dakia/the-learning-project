import { z } from 'zod';

const EngineSelection = z.enum(['fsrs', 'forgetting_candidate']);
/** FSRS stays the default until the candidate engine passes its separate acceptance gate. */
export function selectedForgettingEngine() {
  return EngineSelection.parse(process.env.FORGETTING_ENGINE ?? 'fsrs');
}
