import { errorResponse } from '@/kernel/http';
export const readStartKnowledgeEdges = async (subject: string | undefined) => {
  try {
    const { readKnowledgeEdges } = await import('@/capabilities/knowledge/public');
    const { db } = await import('@/db/client');
    return await readKnowledgeEdges(db, { subject: subject || undefined });
  } catch (error) {
    throw errorResponse(error);
  }
};
