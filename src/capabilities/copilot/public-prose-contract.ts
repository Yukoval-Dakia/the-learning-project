import { z } from 'zod';
import { longQuotaRecoveryTextFromSeconds } from '@/ai/help-provider-fault';
import type { ProviderFailureInfo } from '@/ai/provider-failure';

/** Published prose is display evidence, never execution or tool-success evidence. */
export const CopilotPublicProseFailureSchema = z
  .object({
    kind: z.enum([
      'provider_rejected',
      'rate_limited',
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

export const COPILOT_PROVIDER_REJECTION_REPLY =
  '模型服务拒绝了请求(400)，具体参数原因尚未定位，本次未完成回答';

function retryAfterSentence(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return '';
  const span =
    seconds >= 90 ? `约 ${Math.round(seconds / 60)} 分钟` : `约 ${Math.round(seconds)} 秒`;
  return ` 提供方建议${span}后再试。`;
}

function httpStatusSuffix(status: number | undefined): string {
  return status !== undefined ? `(${status})` : '';
}

/** Safe public copy; the original durable reason/error and paid receipts stay internal. */
export function publicProseFailureMessage(failure?: CopilotPublicProseFailure): string {
  if (failure === undefined) return '这次运行未完成回答。';
  switch (failure.kind) {
    case 'provider_rejected':
      return failure.http_status === 400
        ? COPILOT_PROVIDER_REJECTION_REPLY
        : `模型服务拒绝了本次请求${httpStatusSuffix(failure.http_status)}，本次未完成回答。${retryAfterSentence(failure.retry_after_seconds)}`.trim();
    case 'rate_limited': {
      const recovery = longQuotaRecoveryTextFromSeconds(failure.retry_after_seconds);
      if (recovery !== undefined) {
        return `额度用完了，本次未完成回答。${recovery}恢复。`;
      }
      return `模型额度已达上限${httpStatusSuffix(failure.http_status)}，本次未完成回答。${retryAfterSentence(failure.retry_after_seconds)}`.trim();
    }
    case 'provider_error':
      return `模型服务暂时不可用${httpStatusSuffix(failure.http_status)}，本次未完成回答。${retryAfterSentence(failure.retry_after_seconds)}`.trim();
    case 'timeout':
      return '模型服务响应超时，本次未完成回答。';
    case 'connection':
      return '与模型服务的连接中断，本次未完成回答。';
    case 'cancelled':
      return '已停止这次运行。';
    case 'execution_unknown':
      return '这次运行的执行结果尚未确认；请先确认现有结果，再决定是否重新发起。';
    case 'finalization_failed':
      return '这次回答未完成可验证的收口。';
    default:
      return '这次运行未完成回答。';
  }
}
