// YUK-1528 — the print page's only read: GET /api/worksheet-exports/{token}. Kept out of
// practice-api.ts so the export state schema lands only in the print page's chunk.
import {
  WorksheetExportStateSchema,
  type WorksheetExportStateT,
} from '@/capabilities/practice/api/worksheet-contracts';
import { ApiError, apiOperationJson } from '@/ui/lib/api';

export async function getWorksheetExport(token: string): Promise<WorksheetExportStateT> {
  const body = await apiOperationJson('getWorksheetExport', {
    url: `/api/worksheet-exports/${encodeURIComponent(token)}`,
    method: 'GET',
  });
  // Same schema the route serves; a shape this page cannot read is a load failure, not a
  // half-rendered sheet.
  return WorksheetExportStateSchema.parse(body);
}

export function isExportNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
