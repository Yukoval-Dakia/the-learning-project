import { z } from 'zod';
import type { DomainTool } from '@/kernel/tools/types';

export const PresentPrimaryViewInputSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('tool_result'), ref: z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(120) }) }),
  z.object({ source: z.literal('artifact'), ref: z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(120) }) }),
  z.object({ source: z.literal('ephemeral_html'), ref: z.string().min(1).max(32_000) }),
]);

export type PresentPrimaryViewInput = z.infer<typeof PresentPrimaryViewInputSchema>;

/** A nomination only. The reply finalizer is the authority that can publish it. */
export const presentPrimaryViewTool: DomainTool<PresentPrimaryViewInput, PresentPrimaryViewInput> = {
  name: 'present_primary_view',
  description: 'Nominate one completed result as the user-facing primary view after reviewing it. The server will validate ownership and availability.',
  effect: 'control',
  inputSchema: PresentPrimaryViewInputSchema,
  outputSchema: PresentPrimaryViewInputSchema,
  costClass: 'local',
  mirrorEvent: 'never',
  async execute(_ctx, input) {
    return input;
  },
  summarize(_input, output) {
    return `primary view nominated: ${output.source}`;
  },
};
