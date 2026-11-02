import { createContext, useContext } from 'react';
import {
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';
import { startIngestionOperation } from '@/ui/lib/ingestion-operations';

export type IngestionSessionCreateClient = {
  startIngestionOperation: typeof startIngestionOperation;
  createIngestionSession: (
    body: ApiOperationRequestBody<'createLegacyIngestionSession'>,
  ) => Promise<ApiOperationJsonResponse<'createLegacyIngestionSession'>>;
};
const httpIngestionSessionCreateClient: IngestionSessionCreateClient = {
  startIngestionOperation,
  createIngestionSession: (body) =>
    apiOperationJson('createLegacyIngestionSession', {
      url: '/api/ingestion',
      method: 'POST',
      body,
    }),
};
const IngestionSessionCreateClientContext = createContext<IngestionSessionCreateClient | undefined>(
  undefined,
);
export const IngestionSessionCreateClientProvider = IngestionSessionCreateClientContext.Provider;
export function useIngestionSessionCreateClient(): IngestionSessionCreateClient {
  return useContext(IngestionSessionCreateClientContext) ?? httpIngestionSessionCreateClient;
}
