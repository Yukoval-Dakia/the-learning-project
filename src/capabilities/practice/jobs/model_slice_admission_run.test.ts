import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import type { ModelUnitOutcomeT } from '@/core/schema/assessment';
import { currentModelPins } from '@/server/assessment/model-slice-registry';
import {
  admissionCallWindowMs,
  holdoutItemFromOutcome,
  holdoutRunTally,
  runModelSliceAdmission,
} from './model_slice_admission_run';

describe('runModelSliceAdmission digest', () => {
  // @invariant grading: the holdout digest is the caller's own item JSON, before zod fills group_evidence and materials
  // @fails-if hash the zod-parsed items; a digest of the raw payload is refused as not frozen before the pin check
  it('accepts a digest of the raw items and still refuses a non-current model pin', async () => {
    const pin = currentModelPins().get('JevScoringDecisionTask');
    if (pin === undefined) throw new Error('Jev pin missing');
    const items = [
      {
        item_id: 'i1',
        revision_id: 'rev-1',
        unit: {
          scoring_unit_id: 'u1',
          criterion: {
            kind: 'text_key' as const,
            accepted_texts: ['2'],
            normalization: 'trim' as const,
          },
          points: 1,
        },
        question_parts: [{ part_id: 'p1', prompt_md: '1+1', material_ids: [] }],
        response_slots: [
          { slot_id: 's1', part_id: 'p1', kind: 'text' as const, math_preview: false },
        ],
        slot_responses: [{ slot_id: 's1', kind: 'text' as const, text_md: '2' }],
        reference_points: 1,
      },
    ];
    await expect(
      runModelSliceAdmission({} as never, {
        run_id: 'run-digest',
        slice: {
          subject: 'math',
          response_class: 'free',
          task_kind: 'JevScoringDecisionTask',
          model: 'not-the-current-model',
          model_version: pin.model_version,
        },
        holdout_digest: `sha256:${canonicalHash(items)}`,
        items,
        per_item_max_cost_usd_micros: 1,
        admitted_by: 'test',
      }),
    ).rejects.toThrow(/current pin/);
  });
});

describe('holdout agreement tally', () => {
  // @invariant grading: a timed-out item stays in the agreement denominator as a non-pass, and a missing cost stays unknown
  // @fails-if drop the pending item before the ratio, count the timeout as agreed, or add its missing cost into known_cost_usd_micros
  it('keeps a timed-out item in the denominator and does not treat its missing cost as known', () => {
    const timedOut: ModelUnitOutcomeT = {
      kind: 'pending',
      pending: {
        reason: 'infra_failure',
        retryable: false,
        detail: 'native model deadline/cancellation reached',
      },
      run_refs: ['run-timeout'],
    };
    const scored: ModelUnitOutcomeT = {
      kind: 'scored',
      points_awarded: 1,
      evidence_citations: [],
      run_refs: ['run-scored'],
      cost_usd_micros: 800,
    };
    const pendingItem = holdoutItemFromOutcome(
      { item_id: 'q2', reference_points: 1, unit_points: 1 },
      timedOut,
    );
    const scoredItem = holdoutItemFromOutcome(
      { item_id: 'q1', reference_points: 1, unit_points: 1 },
      scored,
    );
    expect(pendingItem.agreed).toBe(false);
    expect(pendingItem.status).toBe('pending');
    expect(pendingItem.cost_usd_micros).toBeUndefined();
    const tally = holdoutRunTally([scoredItem, pendingItem]);
    expect(tally.items).toBe(2);
    expect(tally.agreed).toBe(1);
    expect(tally.agreement_ratio).toBe(0.5);
    expect(tally.known_cost_usd_micros).toBe(800);
    expect(tally.unknown_cost_items).toBe(1);
  });

  // @invariant grading: a rubric admission call keeps a full second timeout window, and other lanes stay on one window
  // @fails-if the admission deadline is a single 90s budget, so the timeout retry is clipped before it starts
  it('gives rubric admission two timeout windows and leaves other lanes on one', () => {
    expect(admissionCallWindowMs('AssessmentRubricJudgeTask', 180_000)).toBe(360_000);
    expect(admissionCallWindowMs('JevScoringDecisionTask', 15_000)).toBe(15_000);
  });
});
