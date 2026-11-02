import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

// The host owns the shared provider deadline and registry/Db identity. Agency owns
// validation, paid claim, judging, terminal recording and failure release as one operation.
export const answerStartConjectureProbe: FrontdoorContext['submitConjectureProbeAnswer'] = (
  input,
  signal,
) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { submitConjectureProbeAnswer } = await import('@/capabilities/agency/public');
      const { db } = await import('@/db/client');
      return await submitConjectureProbeAnswer(
        db,
        { id: input.probeId },
        async () => JSON.parse(input.body),
        signal,
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });
