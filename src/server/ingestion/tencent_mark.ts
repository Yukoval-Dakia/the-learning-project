import { RetryableError } from '@/core/schema/structured_question';
import { ocr } from 'tencentcloud-sdk-nodejs-ocr';

// Tencent OCR v20181119 API. Mark Agent endpoint 支持完形填空 / 阅读理解嵌套布局
// + 手写答案 bbox + 内置判分 evidence。见 ADR-0002 2026-05-11 修订。
//
// 见 Sub 0c plan Step 6（用官方 SDK 而非手写 V3 签名）。

// biome-ignore lint/suspicious/noExplicitAny: SDK 类型在 v4 里没导出 Client 类型，运行时通过
const OcrClient: any = ocr.v20181119.Client;

function createOcrClient(): InstanceType<typeof OcrClient> {
  // YUK-139 [M2]: fail fast on missing Tencent OCR creds. Previously these were
  // passed straight into the SDK as possibly-undefined, which surfaces as an
  // opaque signature/auth error deep inside the SDK at request time. Validate
  // up front so a misconfigured deploy fails with a clear, actionable message.
  const secretId = process.env.TENCENT_SECRET_ID?.trim();
  const secretKey = process.env.TENCENT_SECRET_KEY?.trim();
  const missing = [!secretId && 'TENCENT_SECRET_ID', !secretKey && 'TENCENT_SECRET_KEY'].filter(
    Boolean,
  );
  if (missing.length > 0) {
    throw new Error(`Tencent OCR client requires ${missing.join(' and ')}`);
  }

  return new OcrClient({
    credential: {
      secretId,
      secretKey,
    },
    region: process.env.TENCENT_OCR_REGION ?? 'ap-shanghai',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } },
  });
}

export type SubmitParams = {
  ImageUrl?: string;
  ImageBase64?: string;
  ImageUrlList?: string[];
};

/** 提交 OCR Mark Agent job，返回 JobId。 */
export async function submitOcrJob(params: SubmitParams): Promise<string> {
  const client = createOcrClient();
  const resp = await client.SubmitQuestionMarkAgentJob(params);
  if (!resp?.JobId) {
    throw new Error('SubmitQuestionMarkAgentJob returned no JobId');
  }
  return resp.JobId;
}

export type DescribeResponse = {
  JobStatus?: 'WAIT' | 'RUN' | 'DONE' | 'FAIL';
  JobErrorMsg?: string;
  ResultList?: unknown[];
  [key: string]: unknown;
};

export type PollOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

/**
 * Poll DescribeQuestionMarkAgentJob until JobStatus is terminal (DONE | FAIL).
 *
 * 终止条件：JobStatus DONE / FAIL 直接 return；超过 timeoutMs 抛 RetryableError
 * （让 pg-boss 重试）。
 */
export async function pollUntilDone(
  jobId: string,
  opts: PollOptions = {},
): Promise<DescribeResponse> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const client = createOcrClient();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = (await client.DescribeQuestionMarkAgentJob({ JobId: jobId })) as DescribeResponse;
    if (resp.JobStatus === 'DONE' || resp.JobStatus === 'FAIL') {
      return resp;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new RetryableError(`Tencent OCR poll timeout after ${timeoutMs}ms (jobId=${jobId})`);
}
