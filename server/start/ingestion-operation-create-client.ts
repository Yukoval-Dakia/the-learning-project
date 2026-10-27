import type { IngestionSessionCreateClient } from '@/capabilities/onboarding/ui-public';
import type {
  IngestionOperationRequest,
  IngestionOperationResource,
} from '@/ui/lib/ingestion-operations';
import { randomId } from '@/ui/lib/random-id';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartIngestionOperationFunction } from './ingestion-operation-create-function';

export const startIngestionOperationClient: IngestionSessionCreateClient['startIngestionOperation'] =
  async <Result = unknown>(
    sessionId: string,
    request: IngestionOperationRequest,
    idempotencyKey: string = randomId(),
  ) => {
    const result: { resource: IngestionOperationResource<Result>; location?: string | null } =
      JSON.parse(
        await createStartIngestionOperationFunction({
          fetch: authenticatedStartFetch,
          headers: { 'Idempotency-Key': idempotencyKey },
          data: { sessionId, body: JSON.stringify(request) },
        }),
      );
    return {
      resource: result.resource,
      location:
        result.location ?? `/api/ingestion-operations/${encodeURIComponent(result.resource.id)}`,
    };
  };
