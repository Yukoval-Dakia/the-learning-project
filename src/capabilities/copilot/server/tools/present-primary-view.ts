import { z } from 'zod';
import type { DomainTool } from '@/kernel/tools/types';
import { EPHEMERAL_HTML_REF_MAX_CHARS } from '../turns';

export const PresentPrimaryViewOutputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('tool_result'),
    ref: z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(120) }),
  }),
  z.object({
    source: z.literal('artifact'),
    ref: z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(120) }),
  }),
  z.object({
    source: z.literal('ephemeral_html'),
    ref: z.string().min(1).max(EPHEMERAL_HTML_REF_MAX_CHARS),
  }),
]);

export type PresentPrimaryViewInput = z.infer<typeof PresentPrimaryViewOutputSchema>;

// mcp-bridge consumes a ZodObject's raw shape. Keep the discriminated pairing
// as a refinement on that object, while the output schema remains the canonical
// typed DTO used by the reply finalizer.
export const PresentPrimaryViewInputSchema = z
  .object({
    source: z.enum(['tool_result', 'artifact', 'ephemeral_html']),
    ref: z.union([
      z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(120) }),
      z.string().min(1).max(EPHEMERAL_HTML_REF_MAX_CHARS),
    ]),
  })
  .superRefine((value, ctx) => {
    if (PresentPrimaryViewOutputSchema.safeParse(value).success) return;
    ctx.addIssue({ code: 'custom', message: 'ref shape does not match primary-view source' });
  });
type PresentPrimaryViewRawInput = z.infer<typeof PresentPrimaryViewInputSchema>;

/** A nomination only. The reply finalizer is the authority that can publish it. */
export const presentPrimaryViewTool: DomainTool<
  PresentPrimaryViewRawInput,
  PresentPrimaryViewInput
> = {
  name: 'present_primary_view',
  description:
    'Nominate one completed result as the user-facing primary view after reviewing it. For tool_result, ref.kind is the exact DomainTool name and ref.id is that successful root call tool_use_id. For artifact, ref.id names an existing live artifact and ref.kind must match its artifact type. ephemeral_html is limited to 32000 characters. The server validates every nomination.',
  effect: 'control',
  inputSchema: PresentPrimaryViewInputSchema,
  outputSchema: PresentPrimaryViewOutputSchema,
  costClass: 'local',
  mirrorEvent: 'never',
  async execute(_ctx, input) {
    return PresentPrimaryViewOutputSchema.parse(input);
  },
  summarize(_input, output) {
    return `primary view nominated: ${output.source}`;
  },
};
