// YUK-1528 — the print page's only read: GET /api/worksheet-exports/{token}. Kept out of
// practice-api.ts so it loads only with the print page.
import type { WorksheetExportStateT } from '@/capabilities/practice/api/worksheet-contracts';
import { ApiError, apiOperationJson } from '@/ui/lib/api';

export async function getWorksheetExport(token: string): Promise<WorksheetExportStateT> {
  const state: WorksheetExportStateT = await apiOperationJson('getWorksheetExport', {
    url: `/api/worksheet-exports/${encodeURIComponent(token)}`,
    method: 'GET',
  });
  return state;
}

export function isExportNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
