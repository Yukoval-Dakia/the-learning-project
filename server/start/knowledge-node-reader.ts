import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

export const readStartKnowledgeNodePage: FrontdoorContext['readKnowledgeNodePage'] = async (id) => {
  try {
    const { KnowledgeIdParamsSchema, loadKnowledgeNodePage } = await import(
      '@/capabilities/knowledge/public'
    );
    const parsed = KnowledgeIdParamsSchema.safeParse({ id });
    if (!parsed.success) {
      throw new ApiError('validation_error', 'knowledge id is required', 400);
    }
    const { isLearnerVisibleKnowledgeId } = await import(
      '@/kernel/read-models/learner-knowledge-visibility'
    );
    if (!isLearnerVisibleKnowledgeId(parsed.data.id)) {
      throw new ApiError('not_found', 'knowledge node not found', 404);
    }
    const { db } = await import('@/db/client');
    const page = await loadKnowledgeNodePage(db, parsed.data.id);
    if (!page) {
      throw new ApiError('not_found', `knowledge ${parsed.data.id} not found`, 404);
    }
    return page;
  } catch (error) {
    throw errorResponse(error);
  }
};
