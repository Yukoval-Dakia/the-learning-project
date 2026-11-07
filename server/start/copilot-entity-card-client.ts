import type { CopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartEntityCardFunction } from './copilot-entity-card-function';

export const startCopilotEntityCardClient: CopilotClient['getEntityCard'] = async (kind, id) =>
  JSON.parse(
    await getStartEntityCardFunction({
      fetch: authenticatedStartFetch,
      data: { kind, id },
    }),
  );
