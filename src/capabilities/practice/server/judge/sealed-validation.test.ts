import { describe, expect, it, vi } from 'vitest';
import { runConfirmedStructuredReview } from '@/server/ai/sealed-validation';

describe('runConfirmedStructuredReview', () => {
  it('requires two valid passes before authorizing pass', async () => {
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'valid',
        task_run_id: 'review-1',
        verdict: 'pass',
        result: { marker: 1 },
      })
      .mockResolvedValueOnce({
        outcome: 'valid',
        task_run_id: 'review-2',
        verdict: 'pass',
        result: { marker: 2 },
      });

    await expect(runConfirmedStructuredReview({ maxAttempts: 2, runAttempt })).resolves.toEqual({
      status: 'decided',
      verdict: 'pass',
      result: { marker: 2 },
      attempts: [
        {
          outcome: 'valid',
          task_run_id: 'review-1',
          verdict: 'pass',
          result: { marker: 1 },
        },
        {
          outcome: 'valid',
          task_run_id: 'review-2',
          verdict: 'pass',
          result: { marker: 2 },
        },
      ],
    });
  });

  it('stops on the first valid fail', async () => {
    const runAttempt = vi.fn(async () => ({
      outcome: 'valid' as const,
      task_run_id: 'review-1',
      verdict: 'fail' as const,
      result: { unsupported: [4] },
    }));

    const result = await runConfirmedStructuredReview({ maxAttempts: 2, runAttempt });

    expect(result).toMatchObject({ status: 'decided', verdict: 'fail' });
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });

  it('does not let a final pass wash away a contract-invalid attempt', async () => {
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'contract_invalid',
        task_run_id: 'review-invalid',
        detail: 'diagnostic_checks.2:invalid_type',
      })
      .mockResolvedValueOnce({
        outcome: 'valid',
        task_run_id: 'review-pass',
        verdict: 'pass',
        result: { marker: 2 },
      });

    await expect(
      runConfirmedStructuredReview({ maxAttempts: 2, runAttempt }),
    ).resolves.toMatchObject({ status: 'invalid', reason: 'pass_not_confirmed' });
  });

  it('allows a valid fail after one contract-invalid attempt', async () => {
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'contract_invalid', task_run_id: 'review-invalid' })
      .mockResolvedValueOnce({
        outcome: 'valid',
        task_run_id: 'review-fail',
        verdict: 'fail',
        result: { unsupported: [7] },
      });

    await expect(
      runConfirmedStructuredReview({ maxAttempts: 2, runAttempt }),
    ).resolves.toMatchObject({ status: 'decided', verdict: 'fail', result: { unsupported: [7] } });
  });
});
