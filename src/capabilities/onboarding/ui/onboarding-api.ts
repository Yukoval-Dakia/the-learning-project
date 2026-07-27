// Onboarding ui data layer (YUK-473 Slice 1).
// At-entry goal create — POST /api/goals (agency capability, LIVE on main).
// Contract mirrors src/capabilities/agency/api/goal-create.ts response.

import {
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';

export type CreateGoalInput = ApiOperationRequestBody<'createGoal'>;
export type CreateGoalResult = ApiOperationJsonResponse<'createGoal'>;

export async function createGoal(input: CreateGoalInput): Promise<CreateGoalResult> {
  return apiOperationJson('createGoal', {
    url: '/api/goals',
    method: 'POST',
    body: input,
  });
}
