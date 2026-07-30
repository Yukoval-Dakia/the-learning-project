import { describe, expect, it } from 'vitest';
import { buildInterventionSettlement, interventionOutcomeFromSettlement } from './intervention';

describe('intervention settlement policy', () => {
  const activatedAt = new Date('2026-07-30T08:00:00.000Z');

  it('pins immediate, delayed, and transfer windows to activation', () => {
    const settlement = buildInterventionSettlement({
      interventionId: 'int_a',
      version: 2,
      activatedAt,
    });

    expect(settlement.diagnostics).toEqual({
      immediate: expect.objectContaining({
        kind: 'immediate',
        question_id: 'intervention:int_a:v2:immediate',
        due_at: '2026-07-30T08:00:00.000Z',
        status: 'scheduled',
      }),
      delayed: expect.objectContaining({
        kind: 'delayed',
        question_id: 'intervention:int_a:v2:delayed',
        due_at: '2026-08-06T08:00:00.000Z',
        status: 'scheduled',
      }),
      transfer: expect.objectContaining({
        kind: 'transfer',
        question_id: 'intervention:int_a:v2:transfer',
        due_at: '2026-08-20T08:00:00.000Z',
        status: 'scheduled',
      }),
    });
  });

  it('requires every window for effective and both durable windows for ineffective', () => {
    const base = buildInterventionSettlement({
      interventionId: 'int_a',
      version: 1,
      activatedAt,
    });
    const withStatuses = (
      immediate: 'passed' | 'failed',
      delayed: 'passed' | 'failed',
      transfer: 'passed' | 'failed',
    ) => ({
      ...base,
      diagnostics: {
        immediate: { ...base.diagnostics.immediate, status: immediate },
        delayed: { ...base.diagnostics.delayed, status: delayed },
        transfer: { ...base.diagnostics.transfer, status: transfer },
      },
    });

    expect(interventionOutcomeFromSettlement(base)).toBeNull();
    expect(interventionOutcomeFromSettlement(withStatuses('passed', 'passed', 'passed'))).toBe(
      'effective',
    );
    expect(interventionOutcomeFromSettlement(withStatuses('passed', 'failed', 'failed'))).toBe(
      'ineffective',
    );
    expect(interventionOutcomeFromSettlement(withStatuses('failed', 'passed', 'passed'))).toBe(
      'inconclusive',
    );
    expect(interventionOutcomeFromSettlement(withStatuses('passed', 'failed', 'passed'))).toBe(
      'inconclusive',
    );
  });
});
