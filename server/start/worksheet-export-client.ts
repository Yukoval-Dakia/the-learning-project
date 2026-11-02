import type { WorksheetExportReader } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { readStartWorksheetExportFunction } from './worksheet-export-function';

export const startWorksheetExportClient: WorksheetExportReader = async (token) =>
  JSON.parse(
    await readStartWorksheetExportFunction({ fetch: authenticatedStartFetch, data: token }),
  );
