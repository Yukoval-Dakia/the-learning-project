// YUK-1528 — the print page's read is injected by the front door (a Start server function), so
// this module only classifies its failure.
import { ApiError } from '@/ui/lib/api';

export function isExportNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
