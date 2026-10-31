import { z } from 'zod';

/** Published prose is display evidence, never execution or tool-success evidence. */
export const CopilotPublicProseFailureSchema = z
  .object({
    kind: z.enum([
      'provider_rejected',
      'execution_failed',
      'finalization_failed',
      'cancelled',
      'execution_unknown',
    ]),
    http_status: z.literal(400).optional(),
  })
  .strict();

export const CopilotPublicProseSchema = z
  .object({
    version: z.literal(1),
    text: z.string(),
    status: z.enum(['streaming', 'completed', 'interrupted', 'failed']),
    last_event_id: z.number().int().nonnegative().safe(),
    failure: CopilotPublicProseFailureSchema.optional(),
  })
  .strict();

export type CopilotPublicProse = z.infer<typeof CopilotPublicProseSchema>;
export type CopilotPublicProseFailure = z.infer<typeof CopilotPublicProseFailureSchema>;

export function parseCopilotPublicProse(value: unknown): CopilotPublicProse | undefined {
  const parsed = CopilotPublicProseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const COPILOT_PROVIDER_REJECTION_REPLY =
  '模型服务拒绝了请求(400)，具体参数原因尚未定位，本次未完成回答';
