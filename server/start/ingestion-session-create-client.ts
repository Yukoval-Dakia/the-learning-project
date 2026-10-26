import type { IngestionSessionCreateClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartIngestionSessionFunction } from './ingestion-session-create-function';

export const startIngestionSessionCreateClient: IngestionSessionCreateClient['createIngestionSession'] =
  async (body) =>
    JSON.parse(
      await createStartIngestionSessionFunction({
        fetch: authenticatedStartFetch,
        data: JSON.stringify(body),
      }),
    );
