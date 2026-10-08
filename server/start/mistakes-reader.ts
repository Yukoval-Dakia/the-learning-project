import { errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Imports and the connection are deferred until the caller has passed token/epoch auth.
export const readStartMistakes: FrontdoorContext['readMistakes'] = async (input) => {
  try {
    const { db } = await import('@/db/client');
    const { readMistakes } = await import('@/capabilities/ingestion/public');
    return await readMistakes(db, input);
  } catch (error) {
    // Shape errors beside the operation. The CJS host and Start ESM bundle have
    // separate ApiError constructors; crossing that boundary with the Error
    // would turn a domain 400 into a generic 500.
    throw errorResponse(error);
  }
};
