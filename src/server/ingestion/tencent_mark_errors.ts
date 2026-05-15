import { PermanentError, RetryableError } from '@/core/schema/structured_question';

/**
 * Tencent Cloud SDK 异常分类 —— 决定 pg-boss 是否 retry。
 *
 * 见 Sub 0c spec § 1.6 + plan Step 6.3。错误码源自 Tencent OCR API 公开文档：
 *   https://cloud.tencent.com/document/api/866/35225#6.-.E9.94.99.E8.AF.AF.E7.A0.81
 *
 * Retryable: 临时性失败（限速 / 服务侧暂时不可用 / 网络抖动）
 * Permanent: 配置 / 数据问题（参数非法 / 认证错 / 账号欠费），重试也不会改观
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
