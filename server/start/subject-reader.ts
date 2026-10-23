import { errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Bound by the frontdoor's initialized Hono graph, never imported by the Start
// function bundle: use the same hydrated registry and fallback cache as HTTP.
export const readStartSubjects: FrontdoorContext['readSubjects'] = async () => {
  try {
    const { db } = await import('@/db/client');
    const { loadLearnerSubjects } = await import('@/capabilities/shell/public');
    return await loadLearnerSubjects(db);
  } catch (error) {
    // Shape errors in their own module graph before crossing into Start ESM.
    throw errorResponse(error);
  }
};
