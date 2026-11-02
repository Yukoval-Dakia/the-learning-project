import type { CopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { cancelStartCopilotRunFunction } from './copilot-cancel-run-function';

export const startCopilotCancelRunClient: CopilotClient['cancelRun'] = async (runId) =>
  JSON.parse(
    await cancelStartCopilotRunFunction({ fetch: authenticatedStartFetch, data: { runId } }),
  );
