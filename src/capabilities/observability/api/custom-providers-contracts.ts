import { z } from 'zod';

/** The slug is the path segment; the provider id is `custom:<slug>`. */
export const CustomProviderParamsSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
  })
  .strict();

export const CustomProviderProtocolSchema = z.enum(['openai-completions', 'anthropic-messages']);

export const CustomProviderPutBodySchema = z
  .object({
    display_name: z.string().min(1).max(80),
    base_url: z.string().url(),
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    protocol: CustomProviderProtocolSchema,
  })
  .strict();

/**
 * One custom provider row for the config panel. Credential honesty matches the
 * rest of the provider surface: the env var NAME and a presence boolean only.
 */
export const CustomProviderSummarySchema = z.object({
  id: z.string(),
  display_name: z.string(),
  base_url: z.string(),
  api_key_env: z.string(),
  protocol: CustomProviderProtocolSchema,
  key_present: z.boolean(),
  /** unconfigured | ok | auth_failed:<status>:<type> | unreachable:<detail> | inference:… */
  auth: z.string(),
  /** Models with catalog facts — the set that passes the save-time runnability check. */
  runnable_models: z.array(z.string()),
  /** Models the endpoint lists but the catalog has no facts for: capability unknown. */
  unknown_models: z.array(z.string()),
  findings: z.number().int().nonnegative(),
});

export const CustomProvidersListResponseSchema = z.object({
  providers: z.array(CustomProviderSummarySchema),
  /** False when the catalog facts source is not wired (unwired tooling/tests): rows then show unprobed, not fabricated state. */
  facts_injected: z.boolean().optional(),
});

export type CustomProviderSummary = z.infer<typeof CustomProviderSummarySchema>;
export type CustomProvidersListResponse = z.infer<typeof CustomProvidersListResponseSchema>;
export type CustomProviderPutBody = z.infer<typeof CustomProviderPutBodySchema>;

export const CustomProviderWriteResponseSchema = z.object({
  provider: CustomProviderSummarySchema,
  catalog: z.union([
    z.object({ outcome: z.literal('stored'), version: z.string() }),
    z.object({ outcome: z.literal('kept'), reason: z.string(), detail: z.string() }),
    z.object({ outcome: z.literal('not_wired') }),
  ]),
});

export const CustomProviderDeleteResponseSchema = z.object({
  removed: z.boolean(),
  catalog_version: z.string().optional(),
});

export type CustomProviderWriteResponse = z.infer<typeof CustomProviderWriteResponseSchema>;
export type CustomProviderDeleteResponse = z.infer<typeof CustomProviderDeleteResponseSchema>;
