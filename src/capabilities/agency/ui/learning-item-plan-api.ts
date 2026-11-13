import {
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';
import { LearningItemPlanResponseSchema, LearningItemPlansResponseSchema } from '../api/contracts';

export type LearningItemPlanPage = ApiOperationJsonResponse<'listOpenLearningItemPlans'>;
export type LearningItemPlan = LearningItemPlanPage['items'][number];
export type LearningItemPlanPatch = ApiOperationRequestBody<'setLearningItemPlan'>;

export const learningItemPlanClient = {
  async list(cursor?: string, signal?: AbortSignal): Promise<LearningItemPlanPage> {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor !== undefined) query.set('cursor', cursor);
    return LearningItemPlansResponseSchema.parse(
      await apiOperationJson('listOpenLearningItemPlans', {
        url: `/api/learning-items?${query}`,
        method: 'GET',
        init: { signal },
      }),
    );
  },
  async patch(id: string, body: LearningItemPlanPatch) {
    return LearningItemPlanResponseSchema.parse(
      await apiOperationJson('setLearningItemPlan', {
        url: `/api/learning-items/${encodeURIComponent(id)}/plan`,
        method: 'PATCH',
        body,
      }),
    );
  },
};

export type LearningItemPlanClient = typeof learningItemPlanClient;
