import { errorResponse } from '@/kernel/http';
export const readStartKnowledgeNodePage = async (id: string) => {
  try {
    const { readLearnerKnowledgeNodePage } = await import('@/capabilities/knowledge/public');
    const { db } = await import('@/db/client');
    return await readLearnerKnowledgeNodePage(db, { id });
  } catch (error) {
    throw errorResponse(error);
  }
};
