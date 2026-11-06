import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readQuestionCard } from '@/kernel/read-models/question-card';

export const readStartQuestionCard = async (id: string, sessionId: string) => {
  try {
    return await readQuestionCard(db, id, sessionId);
  } catch (error) {
    throw errorResponse(error);
  }
};
