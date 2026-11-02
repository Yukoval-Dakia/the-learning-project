import type { CopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartCopilotSessionFunction } from './copilot-session-create-function';

export const startCopilotCreateSessionClient: CopilotClient['createSession'] = async () =>
  JSON.parse(await createStartCopilotSessionFunction({ fetch: authenticatedStartFetch }));
