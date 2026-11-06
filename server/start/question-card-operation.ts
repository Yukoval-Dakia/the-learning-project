import { errorResponse } from '@/kernel/http';

export const readStartQuestionCard = async (id: string, sessionId: string) => {
  try {
    const { readQuestionCard } = await import('@/kernel/read-models/question-card');
    const { db } = await import('@/db/client');
    return await readQuestionCard(db, id, sessionId);
  } catch (error) {
    throw errorResponse(error);
  }
};
