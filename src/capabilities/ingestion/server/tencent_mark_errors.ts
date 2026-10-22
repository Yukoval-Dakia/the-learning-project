import { PermanentError, RetryableError } from '@/core/schema/structured_question';

// Tencent error classification, retained with the selectable tencent engine.

/**
 * Maps Tencent OCR SDK errors to retry decisions. Transient failures (rate limits,
 * temporary outages, network) retry; configuration or data errors (bad params,
 * auth, arrears) are permanent.
 */
export type TencentSdkException = {
  code?: string;
  message?: string;
  requestId?: string;
};

const RETRYABLE_CODE_PREFIXES = [
  'FailedOperation.OcrFailed',
  'FailedOperation.UnKnowError',
  'RequestLimitExceeded',
  'InternalError',
  'ResourceInsufficient',
];

const PERMANENT_CODE_PREFIXES = [
  'InvalidParameter',
  'InvalidParameterValue',
  'AuthFailure',
  'UnauthorizedOperation',
  'ResourceUnavailable.InArrears',
  'ResourceNotFound',
  'FailedOperation.UnsupportedOperation',
];

export function mapTencentError(err: unknown): RetryableError | PermanentError {
  const sdkErr = err as TencentSdkException;
  const code = sdkErr?.code ?? '';
  const message = `Tencent SDK error [${code || 'unknown'}]: ${sdkErr?.message ?? String(err)}`;

  if (RETRYABLE_CODE_PREFIXES.some((p) => code.startsWith(p))) {
    return new RetryableError(message, { cause: err });
  }
  if (PERMANENT_CODE_PREFIXES.some((p) => code.startsWith(p))) {
    return new PermanentError(message, { cause: err });
  }
  // 未知码默认 PermanentError —— 防止无限重试未知错误烧钱
  return new PermanentError(message, { cause: err });
}
