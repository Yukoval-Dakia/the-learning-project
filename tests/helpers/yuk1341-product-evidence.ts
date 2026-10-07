import { z } from 'zod';

// Keep final content and usage only. Unknown keys, including raw reasoning,
// credentials, headers and provider debug extensions, are stripped at each level.
const ProductWireEvidence = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional(),
    })
    .optional(),
  choices: z
    .array(
      z.object({
        index: z.number().optional(),
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          role: z.string().optional(),
          content: z.string().nullable().optional(),
        }),
      }),
    )
    .optional(),
});

export function productWireEvidence(value: unknown) {
  return ProductWireEvidence.parse(value);
}
