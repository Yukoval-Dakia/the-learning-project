import { errorResponse } from '@/kernel/http';

// Loaded through context.adapters from the API graph, so the reader uses the same
// hydrated subject registry, config snapshot and pool as the HTTP routes.
export const readStartSubjects = async () => {
  try {
    const { db } = await import('@/db/client');
    const { loadLearnerSubjects } = await import('@/capabilities/shell/public');
    return await loadLearnerSubjects(db);
  } catch (error) {
    // Shape errors in their own module graph before crossing into Start ESM.
    throw errorResponse(error);
  }
};
