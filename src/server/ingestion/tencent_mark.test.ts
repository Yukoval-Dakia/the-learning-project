import { describe, expect, it, vi } from 'vitest';

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
      Client: vi.fn().mockImplementation(() => ({
        SubmitQuestionMarkAgentJob: submitMock,
        DescribeQuestionMarkAgentJob: describeMock,
      })),
    },
  },
}));

// Import AFTER mock is set up
const { submitOcrJob, pollUntilDone } = await import('./tencent_mark');

describe('submitOcrJob', () => {
  it('forwards params to SDK and returns JobId', async () => {
    submitMock.mockResolvedValueOnce({ JobId: 'job-abc-123' });
    const jobId = await submitOcrJob({ ImageBase64: 'aGVsbG8=' });
    expect(jobId).toBe('job-abc-123');
    expect(submitMock).toHaveBeenCalledWith({ ImageBase64: 'aGVsbG8=' });
  });
});

describe('pollUntilDone', () => {
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

    await expect(
      pollUntilDone('job-3', { intervalMs: 5, timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(RetryableError);
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
