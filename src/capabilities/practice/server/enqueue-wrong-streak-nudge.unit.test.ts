import { beforeEach, describe, expect, it, vi } from 'vitest';

const bossSend = vi.fn();
const shouldEnqueue = vi.fn();

vi.mock('@/server/boss/client', () => ({
  getStartedBoss: async () => ({ send: bossSend }),
}));
vi.mock('@/server/runtime-env', () => ({
  shouldEnqueueBackgroundJobs: () => shouldEnqueue(),
}));

import { enqueueWrongStreakNudge } from './enqueue-wrong-streak-nudge';

describe('enqueueWrongStreakNudge', () => {
  beforeEach(() => {
    bossSend.mockReset();
    shouldEnqueue.mockReset().mockReturnValue(true);
  });

  it('sends a failure attempt to the shared FAST evaluator queue', async () => {
    await enqueueWrongStreakNudge('failure', 'attempt_1');
    expect(bossSend).toHaveBeenCalledWith('copilot_nudge_evaluate', {
      kind: 'attempt_failure',
      attempt_event_id: 'attempt_1',
    });
  });

  it.each(['success', 'partial'] as const)('does not enqueue %s outcomes', async (outcome) => {
    await enqueueWrongStreakNudge(outcome, 'attempt_1');
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('does not enqueue when background jobs are disabled', async () => {
    shouldEnqueue.mockReturnValue(false);
    await enqueueWrongStreakNudge('failure', 'attempt_1');
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('keeps the committed attempt successful when enqueue fails', async () => {
    bossSend.mockRejectedValueOnce(new Error('boss unavailable'));
    await expect(enqueueWrongStreakNudge('failure', 'attempt_1')).resolves.toBeUndefined();
  });
});
