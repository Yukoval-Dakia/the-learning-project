import type { CopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { revertStartCopilotCheckpointFunction } from './copilot-checkpoint-revert-function';

export const startCopilotCheckpointRevertClient: CopilotClient['revertCheckpoint'] = async (
  checkpointEventId,
) =>
  JSON.parse(
    await revertStartCopilotCheckpointFunction({
      fetch: authenticatedStartFetch,
      data: { checkpointEventId },
    }),
  );
