import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const cancelStartCopilotRun: FrontdoorContext['cancelCopilotRun'] = (runId) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { cancelCopilotRun, dispatchSessionHead } = await import(
        '@/capabilities/copilot/public'
      );
      const { db } = await import('@/db/client');
      const bossClient = await import('@/server/boss/client');
      return await cancelCopilotRun(db, { id: runId }, async (sessionId) =>
        dispatchSessionHead(db, sessionId, {
          boss: await bossClient.getStartedBoss(),
          transactionDb: bossClient.fromPgBossDrizzleTx,
        }),
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });
