import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import { mapTencentError } from './tencent_mark_errors';

// Hoisted mocks so vi.mock factory can close over them
const { submitMock, describeMock } = vi.hoisted(() => ({
  submitMock: vi.fn(),
  describeMock: vi.fn(),
}));

vi.mock('tencentcloud-sdk-nodejs-ocr', () => ({
  ocr: {
    v20181119: {
      // vitest 4: a `vi.fn()` used with `new` must use a `function`/`class`
      // implementation — an arrow returning an object is no longer constructable
      // ("not a constructor"). createOcrClient does `new OcrClient(...)`, so the
      // mock constructor assigns the stubbed SDK methods onto `this`.
      // See vitest 4 migration: spyOn/fn support constructors.
      Client: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.SubmitQuestionMarkAgentJob = submitMock;
        this.DescribeQuestionMarkAgentJob = describeMock;
      }),
    },
  },
}));

// Import AFTER mock is set up
const { submitOcrJob, pollUntilDone } = await import('./tencent_mark');

// YUK-139 [M2]: createOcrClient now fails fast when the Tencent creds are
// missing. The happy-path tests below need valid creds in env; vi.stubEnv +
// vi.unstubAllEnvs handles save/restore (and true removal of unset vars) so
// nothing leaks across files.
function restoreTencentEnv() {
  vi.unstubAllEnvs();
}

describe('submitOcrJob', () => {
  beforeEach(() => {
    vi.stubEnv('TENCENT_SECRET_ID', 'test-secret-id');
    vi.stubEnv('TENCENT_SECRET_KEY', 'test-secret-key');
  });
  afterEach(restoreTencentEnv);

  it('forwards params to SDK and returns JobId', async () => {
    submitMock.mockResolvedValueOnce({ JobId: 'job-abc-123' });
    const jobId = await submitOcrJob({ ImageBase64: 'aGVsbG8=' });
    expect(jobId).toBe('job-abc-123');
    expect(submitMock).toHaveBeenCalledWith({ ImageBase64: 'aGVsbG8=' });
  });
});

describe('createOcrClient credential validation (YUK-139)', () => {
  afterEach(restoreTencentEnv);

  it('throws a clear error when TENCENT_SECRET_ID is missing', async () => {
    vi.stubEnv('TENCENT_SECRET_ID', undefined);
    vi.stubEnv('TENCENT_SECRET_KEY', 'test-secret-key');
    await expect(submitOcrJob({ ImageBase64: 'aGVsbG8=' })).rejects.toThrow(/TENCENT_SECRET_ID/);
  });

  it('throws a clear error when TENCENT_SECRET_KEY is missing', async () => {
    vi.stubEnv('TENCENT_SECRET_ID', 'test-secret-id');
    vi.stubEnv('TENCENT_SECRET_KEY', undefined);
    await expect(submitOcrJob({ ImageBase64: 'aGVsbG8=' })).rejects.toThrow(/TENCENT_SECRET_KEY/);
  });

  it('throws naming both when neither is set, before touching the SDK', async () => {
    vi.stubEnv('TENCENT_SECRET_ID', undefined);
    vi.stubEnv('TENCENT_SECRET_KEY', undefined);
    submitMock.mockClear();
    await expect(submitOcrJob({ ImageBase64: 'aGVsbG8=' })).rejects.toThrow(
      /TENCENT_SECRET_ID and TENCENT_SECRET_KEY/,
    );
    // fail-fast: the SDK call must never be reached
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('treats blank / whitespace-only creds as missing', async () => {
    vi.stubEnv('TENCENT_SECRET_ID', '   ');
    vi.stubEnv('TENCENT_SECRET_KEY', '');
    await expect(submitOcrJob({ ImageBase64: 'aGVsbG8=' })).rejects.toThrow(
      /TENCENT_SECRET_ID and TENCENT_SECRET_KEY/,
    );
  });

  it('does not throw when both creds are present', async () => {
    vi.stubEnv('TENCENT_SECRET_ID', 'test-secret-id');
    vi.stubEnv('TENCENT_SECRET_KEY', 'test-secret-key');
    submitMock.mockResolvedValueOnce({ JobId: 'job-ok' });
    await expect(submitOcrJob({ ImageBase64: 'aGVsbG8=' })).resolves.toBe('job-ok');
  });
});

describe('pollUntilDone', () => {
  beforeEach(() => {
    vi.stubEnv('TENCENT_SECRET_ID', 'test-secret-id');
    vi.stubEnv('TENCENT_SECRET_KEY', 'test-secret-key');
  });
  afterEach(restoreTencentEnv);

  it('polls until DONE and returns the response', async () => {
    describeMock.mockReset();
    describeMock
      .mockResolvedValueOnce({ JobStatus: 'WAIT' })
      .mockResolvedValueOnce({ JobStatus: 'RUN' })
      .mockResolvedValueOnce({
        JobStatus: 'DONE',
        ResultList: [{ stem: 'mock content' }],
      });

    const result = await pollUntilDone('job-1', { intervalMs: 5, timeoutMs: 1_000 });
    expect(result.JobStatus).toBe('DONE');
    expect(describeMock).toHaveBeenCalledTimes(3);
  });

  it('returns FAIL response without throwing (caller decides)', async () => {
    describeMock.mockReset();
    describeMock.mockResolvedValueOnce({
      JobStatus: 'FAIL',
      JobErrorMsg: 'something bad',
    });
    const result = await pollUntilDone('job-2', { intervalMs: 5, timeoutMs: 1_000 });
    expect(result.JobStatus).toBe('FAIL');
  });

  it('throws RetryableError when timeout exceeded', async () => {
    describeMock.mockReset();
    describeMock.mockResolvedValue({ JobStatus: 'RUN' }); // never finishes

    await expect(pollUntilDone('job-3', { intervalMs: 5, timeoutMs: 30 })).rejects.toBeInstanceOf(
      RetryableError,
    );
  });
});

describe('mapTencentError', () => {
  it('maps FailedOperation.OcrFailed → RetryableError', () => {
    const err = mapTencentError({ code: 'FailedOperation.OcrFailed', message: 'try again' });
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.message).toContain('FailedOperation.OcrFailed');
  });

  it('maps RequestLimitExceeded → RetryableError', () => {
    const err = mapTencentError({ code: 'RequestLimitExceeded', message: 'rate limited' });
    expect(err).toBeInstanceOf(RetryableError);
  });

  it('maps InvalidParameterValue.* → PermanentError', () => {
    const err = mapTencentError({
      code: 'InvalidParameterValue.ImageBase64',
      message: 'bad base64',
    });
    expect(err).toBeInstanceOf(PermanentError);
  });

  it('maps ResourceUnavailable.InArrears → PermanentError (账号欠费)', () => {
    const err = mapTencentError({ code: 'ResourceUnavailable.InArrears', message: 'paid up' });
    expect(err).toBeInstanceOf(PermanentError);
  });

  it('unknown code defaults to PermanentError (避免无限 retry 烧钱)', () => {
    const err = mapTencentError({ code: 'SomeBrandNewCode', message: 'mystery' });
    expect(err).toBeInstanceOf(PermanentError);
  });

  it('handles raw Error (non-SDK shape)', () => {
    const err = mapTencentError(new Error('plain error'));
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('plain error');
  });
});
