import { describe, expect, it } from 'vitest';
import {
  arrangeSchema,
  evidenceSchema,
} from '@/capabilities/practice/testing/pi-dbos-gate/operations';
import { answerFixture, modelCommand } from './fixture';

describe('YUK-1338 controlled model and command boundary', () => {
  it('retains long ambiguous evidence and distinguishes assisted success from independent transfer', () => {
    const evidence = evidenceSchema.parse(answerFixture('answer-a'));
    expect(evidence.answer.length).toBeGreaterThan(2000);
    expect(evidence.observations).toHaveLength(3);
    const snapshot = {
      learnerId: 'learner',
      version: 2,
      evidence,
      evidenceCommittedAt: '2026-10-07T00:00:00Z',
      nextActivity: null,
    };
    expect(modelCommand(snapshot, 'op', '2026-10-08T00:00:00Z').nextActivity).toBe(
      'ellipse-supported-review',
    );
    expect(
      modelCommand(
        { ...snapshot, evidence: answerFixture('answer-b', true) },
        'op',
        '2026-10-08T00:00:00Z',
      ).nextActivity,
    ).toBe('ellipse-transfer');
  });

  it('rejects malformed observations, undeclared fields, fractional versions and unsupported activity', () => {
    const evidence = answerFixture('answer-c');
    expect(
      evidenceSchema.safeParse({
        ...evidence,
        observations: [{ part: 'b', note: 'ambiguous', confidence: 1.1 }],
      }).success,
    ).toBe(false);
    const command = modelCommand(
      {
        learnerId: 'learner',
        version: 2,
        evidence,
        evidenceCommittedAt: '2026-10-07T00:00:00Z',
        nextActivity: null,
      },
      'op',
      '2026-10-08T00:00:00Z',
    );
    for (const patch of [
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { nextActivity: 'erase-history' },
      { validUntil: 'tomorrow' },
      { providerKey: 'forbidden' },
    ]) {
      expect(arrangeSchema.safeParse({ ...command, ...patch }).success).toBe(false);
    }
  });
});
