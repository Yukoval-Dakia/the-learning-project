import { describe, expect, it } from 'vitest';
import {
  buildInterventionSettlement,
  interventionOutcomeFromSettlement,
  reanchorInterventionFollowupDiagnostics,
} from './intervention';

describe('intervention settlement policy', () => {
  const activatedAt = new Date('2026-07-30T08:00:00.000Z');

  it('keeps provisional windows deterministic, then anchors follow-ups to confirmed exposure', () => {
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

    const exposed = reanchorInterventionFollowupDiagnostics({
      ...settlement,
      diagnostics: {
        ...settlement.diagnostics,
        immediate: {
          ...settlement.diagnostics.immediate,
          status: 'passed',
          review_event_id: 'review_immediate',
          verdict_event_id: 'judge_immediate',
          completed_at: '2026-08-02T12:34:56.000Z',
        },
      },
    });
    expect(exposed.diagnostics.delayed.due_at).toBe('2026-08-09T12:34:56.000Z');
    expect(exposed.diagnostics.transfer.due_at).toBe('2026-08-23T12:34:56.000Z');
    expect(reanchorInterventionFollowupDiagnostics(exposed)).toEqual(exposed);
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
