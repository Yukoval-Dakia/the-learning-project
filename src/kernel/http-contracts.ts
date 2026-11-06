import { z } from 'zod';

/** Marker used by OpenAPI generation for a real binary request part or response body. */
export const OPENAPI_BINARY_CONTENT_DESCRIPTION = 'Binary HTTP content';
export const MultipartFilePartSchema = z
  .instanceof(File)
  .describe(OPENAPI_BINARY_CONTENT_DESCRIPTION);
export const BinaryResponseSchema = z.string().describe(OPENAPI_BINARY_CONTENT_DESCRIPTION);

export const ApiErrorResponseSchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
  })
  .passthrough();

export const API_ERROR_RESPONSES = {
  400: ApiErrorResponseSchema,
  401: ApiErrorResponseSchema,
  404: ApiErrorResponseSchema,
  409: ApiErrorResponseSchema,
  422: ApiErrorResponseSchema,
  429: ApiErrorResponseSchema,
  500: ApiErrorResponseSchema,
} as const;

export const ApiIdParamsSchema = z.object({ id: z.string().min(1) });

export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const ApiPageSchema = z.object({
  limit: z.number().int().positive(),
  next_cursor: z.string().nullable(),
});

export function collectionResponseSchema(item: z.ZodTypeAny) {
  return z
    .object({
      data: z.array(item),
      page: ApiPageSchema,
    })
    .passthrough();
}
