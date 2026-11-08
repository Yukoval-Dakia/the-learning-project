import { z } from 'zod';
import { longQuotaRecoveryTextFromSeconds } from '@/ai/help-provider-fault';
import type { ProviderFailureInfo } from '@/ai/provider-failure';

/** Published prose is display evidence, never execution or tool-success evidence. */
export const CopilotPublicProseFailureSchema = z
  .object({
    kind: z.enum([
      'provider_rejected',
      'rate_limited',
      'quota',
      'provider_error',
      'timeout',
      'connection',
      'execution_failed',
      'finalization_failed',
      'cancelled',
      'execution_unknown',
    ]),
    /** Bound provider HTTP status when one was observed (400..599). */
    http_status: z.number().int().min(100).max(599).optional(),
    /** The provider's own Retry-After, whole seconds; absent when it sent none. */
    retry_after_seconds: z.number().nonnegative().optional(),
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

/** Execution-boundary provider classification → wire failure shape. */
export function providerFailureToPublicFailure(
  info: ProviderFailureInfo,
): CopilotPublicProseFailure {
  return {
    kind: info.category,
    ...(info.http_status !== undefined ? { http_status: info.http_status } : {}),
    ...(info.retry_after_ms !== undefined
      ? { retry_after_seconds: Math.ceil(info.retry_after_ms / 1000) }
      : {}),
  };
}

export const COPILOT_PROVIDER_REJECTION_REPLY = '这次没答成，可以换个说法再试一次。';
/** Stored as the reply when a run ended with nothing written and no provider failure to name. */
export const COPILOT_FINALIZATION_FAILURE_REPLY = '这次回复未能完成，已有内容已保留。';

function retryAfterSentence(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return '';
  const span =
    seconds >= 90 ? `约 ${Math.round(seconds / 60)} 分钟` : `约 ${Math.round(seconds)} 秒`;
  return `${span}后再试一次。`;
}

/** Safe public copy; the original durable reason/error and paid receipts stay internal. */
export function publicProseFailureMessage(failure?: CopilotPublicProseFailure): string {
  if (failure === undefined) return '这次没答完。';
  switch (failure.kind) {
    case 'provider_rejected':
      // 401/403/404 等拒绝不是问法问题，不提示换说法或重试。
      return failure.http_status === 400 ? COPILOT_PROVIDER_REJECTION_REPLY : '这次没答成。';
    case 'rate_limited':
      return `现在有点忙，这次没答完。${retryAfterSentence(failure.retry_after_seconds) || '过一会儿再试试。'}`;
    case 'quota': {
      // Only a signature-proven quota reaches this kind — real quota responses
      // carry no Retry-After, so absence must not downgrade the copy to "busy".
      const recovery = longQuotaRecoveryTextFromSeconds(failure.retry_after_seconds);
      return recovery !== undefined
        ? `额度用完了，本次未完成回答。${recovery}恢复。`
        : '额度用完了，这次没答完。恢复之后再来。';
    }
    case 'provider_error':
      return `服务暂时出了点问题，这次没答完。${retryAfterSentence(failure.retry_after_seconds)}`;
    case 'timeout':
      return '等得太久了，这次没答完。';
    case 'connection':
      return '连接断了一下，这次没答完。';
    case 'cancelled':
      return '这次已按你的意思停下。';
    case 'execution_unknown':
      return '这次的结果还没确认；先看看已经有的内容，再决定要不要再来一次。';
    case 'finalization_failed':
      return '这次回答没能完整收尾。';
    default:
      return '这次没答完。';
  }
}
