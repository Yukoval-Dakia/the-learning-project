import type { PlacementClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartJudgeRunStatus } from './judge-status-function';

export const startJudgeRunStatusClient: NonNullable<PlacementClient['readJudgeRunStatus']> = async (
  runId,
) => JSON.parse(await getStartJudgeRunStatus({ fetch: authenticatedStartFetch, data: runId }));
