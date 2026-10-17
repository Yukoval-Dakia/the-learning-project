import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import { currentModelPins } from '@/server/assessment/model-slice-registry';
import { runModelSliceAdmission } from './model_slice_admission_run';

// @invariant grading: the holdout digest is the caller's own item JSON, before zod fills group_evidence and materials
// @fails-if hash the zod-parsed items; a digest of the raw payload is refused as not frozen before the pin check
describe('runModelSliceAdmission digest', () => {
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
