import { z } from 'zod';

import { OPENAPI_BINARY_CONTENT_DESCRIPTION } from '@/kernel/http-contracts';

/**
 * `include_assets=1` is the only truthy value at runtime. Other string values
 * remain accepted and behave like the omitted query parameter for compatibility.
 */
export const BackupExportQuerySchema = z.object({
  include_assets: z.string().optional(),
});

export const BackupImportQuerySchema = z.object({
  confirm: z.literal('wipe-and-reload'),
});

/** OpenAPI marker for the raw ZIP request and response body. */
export const BackupArchiveBodySchema = z.string().describe(OPENAPI_BINARY_CONTENT_DESCRIPTION);

export const BackupExportErrorSchema = z.object({
  error: z.literal('too_many_assets'),
  count: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  suggestion: z.string(),
});

const BackupRestoreStatsSchema = z.object({
  deleted: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
});

export const BackupImportResponseSchema = z.object({
  ok: z.boolean(),
  stats: z.record(z.string(), BackupRestoreStatsSchema),
  assets_uploaded: z.number().int().nonnegative(),
  assets_failed: z.number().int().nonnegative(),
  failed_keys: z.array(z.string()),
});
