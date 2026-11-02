import type { CopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { acceptStartTeachingChipFunction } from './copilot-teaching-chip-function';

export const startCopilotTeachingChipClient: CopilotClient['acceptTeachingChip'] = async (
  sessionId,
  body,
) =>
  JSON.parse(
    await acceptStartTeachingChipFunction({
      fetch: authenticatedStartFetch,
      data: { sessionId, body: JSON.stringify(body) },
    }),
  );
