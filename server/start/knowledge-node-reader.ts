import { errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

export const readStartKnowledgeNodePage: FrontdoorContext['readKnowledgeNodePage'] = async (id) => {
  try {
    const { readLearnerKnowledgeNodePage } = await import('@/capabilities/knowledge/public');
    const { db } = await import('@/db/client');
    return await readLearnerKnowledgeNodePage(db, { id });
  } catch (error) {
    throw errorResponse(error);
  }
};
