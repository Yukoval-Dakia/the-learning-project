import type { GoalClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartGoalFunction } from './goal-create-function';

export const startGoalCreateClient: GoalClient['createGoal'] = async (input) =>
  JSON.parse(
    await createStartGoalFunction({ fetch: authenticatedStartFetch, data: JSON.stringify(input) }),
  );
