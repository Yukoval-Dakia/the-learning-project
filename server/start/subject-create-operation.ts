import { errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Stay in the initialized host graph: the canonical writer commits and hydrates its registry.
export const createStartSubject: FrontdoorContext['createSubject'] = async (displayName) => {
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
