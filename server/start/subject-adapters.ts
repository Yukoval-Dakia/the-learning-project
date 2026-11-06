// Start-side adapters for this family. `frontdoor.ts` loads this module from the API
// graph, so every adapter below runs with the initialized subject registry, config
// snapshot and database pool; each keeps its own conversion, error and deadline handling.

import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';

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

// Stay in the initialized host graph: the canonical writer commits and hydrates its registry.
export const createStartSubject = async (displayName: string) => {
  try {
    if (typeof displayName !== 'string') {
      throw Response.json({ error: 'displayName (string) is required' }, { status: 400 });
    }
    const { db } = await import('@/db/client');
    const { thinCreateSubject } = await import('@/capabilities/observability/public');
    const result = await thinCreateSubject(db, displayName);
    switch (result.kind) {
      case 'created':
      case 'replayed':
        return result.payload;
      case 'invalid':
        throw Response.json({ error: result.message }, { status: 400 });
      case 'name_conflict':
        throw Response.json({ error: result.message }, { status: 422 });
    }
  } catch (error) {
    // Keep human-readable body.error as ApiError.code for the existing 422 UI branch.
    throw error instanceof Response ? error : errorResponse(error);
  }
};

// Subject normalization and goal materialization use the initialized host registry/Db.
export const createStartGoal = (body: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new ApiError('validation_error', 'request body must be valid JSON', 400);
      }
      const { createGoal } = await import('@/capabilities/agency/public');
      const { db } = await import('@/db/client');
      return await createGoal(db, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const createStartLearningIntent = (body: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    const agency = await import('@/capabilities/agency/public');
    try {
      const { db } = await import('@/db/client');
      return await agency.requestLearningIntent(db, async () => JSON.parse(body));
    } catch (error) {
      throw agency.learningIntentErrorResponse(error);
    }
  });

export const subjectAdapters = {
  readStartSubjects,
  createStartSubject,
  createStartGoal,
  createStartLearningIntent,
};
