import { ocr } from 'tencentcloud-sdk-nodejs-ocr';
import { RetryableError } from '@/core/schema/structured_question';

// Tencent OCR client, retained permanently as the selectable
// EXTRACT_OCR_ENGINE='tencent' engine; dual engines allow same-page A/B quality
// comparison and per-scenario switching.
//
// Uses the official v20181119 SDK. Mark Agent supports nested cloze/reading
// layouts, handwriting bboxes, and grading evidence (ADR-0002 revision).

// biome-ignore lint/suspicious/noExplicitAny: SDK 类型在 v4 里没导出 Client 类型，运行时通过
const OcrClient: any = ocr.v20181119.Client;

function createOcrClient(): InstanceType<typeof OcrClient> {
  // Fail fast on missing credentials; otherwise the SDK reports an opaque auth
  // error at request time.
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

export async function describeOcrJob(jobId: string): Promise<DescribeResponse> {
  const client = createOcrClient();
  return (await client.DescribeQuestionMarkAgentJob({ JobId: jobId })) as DescribeResponse;
}

export type PollOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  describeFn?: typeof describeOcrJob;
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
  const describe = opts.describeFn ?? describeOcrJob;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await describe(jobId);
    if (resp.JobStatus === 'DONE' || resp.JobStatus === 'FAIL') {
      return resp;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new RetryableError(`Tencent OCR poll timeout after ${timeoutMs}ms (jobId=${jobId})`);
}
