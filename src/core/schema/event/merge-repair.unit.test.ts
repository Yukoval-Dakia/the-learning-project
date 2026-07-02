// YUK-543 (OCR O5/O6) — MergeRepairEntry forensic-schema guards: .strict() on both the entry and
// the edges_rewired element (a typo'd key must fail loudly, never be silently stripped), and the
// outcome↔new_edge_id coupling superRefine (rewired/reactivated ⇔ non-null; archive-only ⇔ null).

import { describe, expect, it } from 'vitest';
import { MergeRepairEntry } from './known';

function validEntry(over: Record<string, unknown> = {}) {
  return {
    from_id: 'k_from',
    question_ids_rewritten: ['q1'],
    learning_item_ids_rewritten: [],
    goal_ids_rewritten: [],
    edges_rewired: [{ old_edge_id: 'e1', new_edge_id: 'e2', outcome: 'rewired' }],
    mastery_state: 'renamed',
    fsrs_state: 'noop',
    axis_state: 'noop',
    kc_typed_state: 'frozen',
    misconception_edges_rewritten: [],
    ...over,
  };
}

describe('MergeRepairEntry (YUK-543 O5/O6)', () => {
  it('accepts a well-formed entry (all five outcomes with the right new_edge_id nullability)', () => {
    expect(MergeRepairEntry.safeParse(validEntry()).success).toBe(true);
    for (const [outcome, newEdgeId] of [
      ['rewired', 'e2'],
      ['reactivated', 'e_tomb'],
      ['collapsed_self_loop', null],
      ['archived_duplicate', null],
      ['archived_dangling', null],
    ] as const) {
      const r = MergeRepairEntry.safeParse(
        validEntry({ edges_rewired: [{ old_edge_id: 'e1', new_edge_id: newEdgeId, outcome }] }),
      );
      expect(r.success, `outcome=${outcome}`).toBe(true);
    }
  });

  it('rejects an unknown top-level key (.strict())', () => {
    const r = MergeRepairEntry.safeParse(validEntry({ question_ids_rewrote: [] }));
    expect(r.success).toBe(false);
  });

  it('rejects an unknown key inside an edges_rewired element (.strict())', () => {
    const r = MergeRepairEntry.safeParse(
      validEntry({
        edges_rewired: [{ old_edge_id: 'e1', new_edge_id: 'e2', outcome: 'rewired', stray: 1 }],
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects outcome 'rewired' with new_edge_id null (coupling superRefine)", () => {
    const r = MergeRepairEntry.safeParse(
      validEntry({ edges_rewired: [{ old_edge_id: 'e1', new_edge_id: null, outcome: 'rewired' }] }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects outcome 'archived_duplicate' with a non-null new_edge_id (coupling superRefine)", () => {
    const r = MergeRepairEntry.safeParse(
      validEntry({
        edges_rewired: [{ old_edge_id: 'e1', new_edge_id: 'e2', outcome: 'archived_duplicate' }],
      }),
    );
    expect(r.success).toBe(false);
  });
});
