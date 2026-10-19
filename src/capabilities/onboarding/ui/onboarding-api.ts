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
