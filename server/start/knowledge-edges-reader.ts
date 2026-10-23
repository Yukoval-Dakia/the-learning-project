import { errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

export const readStartKnowledgeEdges: FrontdoorContext['readKnowledgeEdges'] = async (subject) => {
  try {
    const { readKnowledgeEdges } = await import('@/capabilities/knowledge/public');
    const { db } = await import('@/db/client');
    return await readKnowledgeEdges(db, { subject: subject || undefined });
  } catch (error) {
    throw errorResponse(error);
  }
};
