import { describe, expect, it } from 'vitest';

import { copilotCorrectionIntentTaskSpec } from './correction-intent';

describe('CopilotCorrectionIntentTask', () => {
  it('parses a bounded correction candidate decision', () => {
    const result = copilotCorrectionIntentTaskSpec.parseText(
      '{"intent":"correction","candidate_prior_turn_ids":["copilot_reply_battery_d04"]}',
    );

    expect(result).toEqual({
      intent: 'correction',
      candidate_prior_turn_ids: ['copilot_reply_battery_d04'],
    });
  });

  it('rejects fields outside the closed intent contract', () => {
    const result = copilotCorrectionIntentTaskSpec.outputSchema.safeParse({
      intent: 'not_correction',
      rationale: 'ordinary follow-up',
    });

    expect(result.success).toBe(false);
  });
});
