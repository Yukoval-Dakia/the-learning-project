import { z } from 'zod';

export const EPHEMERAL_HTML_REF_MAX_CHARS = 32_000;
export const TOOL_RESULT_VALUE_MAX_BYTES = 32_000;

export type ToolResultJson =
  | null
  | boolean
  | number
  | string
  | ToolResultJson[]
  | { [key: string]: ToolResultJson };

export const ToolResultOmissionSchema = z
  .object({
    path: z.string().min(1).max(240),
    reason: z.enum(['private', 'opaque', 'display_limit']),
    omitted_count: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ToolResultOmission = z.infer<typeof ToolResultOmissionSchema>;

export const CopilotToolResultSnapshotSchema = z.discriminatedUnion('state', [
  z
    .object({
      version: z.literal(1),
      state: z.literal('available'),
      value: z.json(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byte_length: z.number().int().nonnegative().max(TOOL_RESULT_VALUE_MAX_BYTES),
      completeness: z.enum(['complete', 'projected']),
      omissions: z.array(ToolResultOmissionSchema).max(100),
    })
    .strict()
    .superRefine((snapshot, ctx) => {
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot.value)).byteLength;
      if (bytes !== snapshot.byte_length || bytes > TOOL_RESULT_VALUE_MAX_BYTES)
        ctx.addIssue({ code: 'custom', message: 'tool-result snapshot byte bound mismatch' });
      if (snapshot.completeness === 'complete' && snapshot.omissions.length > 0)
        ctx.addIssue({ code: 'custom', message: 'complete snapshot cannot omit fields' });
    }),
  z
    .object({
      version: z.literal(1),
      state: z.literal('unavailable'),
      reason: z.enum(['internal_only', 'content_rejected', 'size_limit', 'unsupported_result']),
    })
    .strict(),
]);
export type CopilotToolResultSnapshot = z.infer<typeof CopilotToolResultSnapshotSchema>;

const PrimaryViewRefSchema = z
  .object({
    kind: z.string().min(1).max(40),
    id: z.string().min(1).max(120),
  })
  .strict();

/** Product DTO only. Model presentation controls never accept a snapshot. */
export const CopilotPrimaryViewSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('tool_result'),
      ref: PrimaryViewRefSchema,
      snapshot: CopilotToolResultSnapshotSchema.optional(),
    })
    .strict(),
  z.object({ source: z.literal('artifact'), ref: PrimaryViewRefSchema }).strict(),
  z
    .object({
      source: z.literal('ephemeral_html'),
      ref: z.string().min(1).max(EPHEMERAL_HTML_REF_MAX_CHARS),
    })
    .strict(),
]);
export type CopilotPrimaryView = z.infer<typeof CopilotPrimaryViewSchema>;

/** Corrupt optional metadata must not discard the surrounding conversation. */
export function parseCopilotPrimaryView(value: unknown): CopilotPrimaryView | undefined {
  try {
    const parsed = CopilotPrimaryViewSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const view = value as Record<string, unknown>;
      if (view.source === 'tool_result') {
        const legacy = CopilotPrimaryViewSchema.safeParse({ source: view.source, ref: view.ref });
        if (legacy.success) return legacy.data;
      }
    }
  } catch {
    // Untrusted historical JSON may exceed recursive parser limits.
  }
  return undefined;
}
