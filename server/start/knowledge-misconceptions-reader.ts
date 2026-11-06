import { ApiError, errorResponse } from '@/kernel/http';
export const readStartKnowledgeMisconceptions = async (id: string) => {
  try {
    const { KnowledgeIdParamsSchema, loadMisconceptionsForKc } = await import(
      '@/capabilities/knowledge/public'
    );
    const parsed = KnowledgeIdParamsSchema.safeParse({ id });
    if (!parsed.success) {
      throw new ApiError('validation_error', 'knowledge id is required', 400);
    }
    const { db } = await import('@/db/client');
    return { rows: await loadMisconceptionsForKc(db, parsed.data.id) };
  } catch (error) {
    throw errorResponse(error);
  }
};
