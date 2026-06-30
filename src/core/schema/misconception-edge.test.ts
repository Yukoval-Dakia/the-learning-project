// YUK-531 (A5 S4 / ADR-0036 RT1) — misconception_edge red-line contract.
//
// Mirrors misconception.test.ts: the hand-written Zod must
//   (a) parse a valid heterogeneous edge row,
//   (b) REJECT any soft-track diagnostic field (theta/pL/mastery/fsrs/difficulty/b)
//       — ADR-0035 misconception edges are SOFT track, no IRT/CDM/FSRS write path,
//   (c) REJECT a `subject`/`domain` field (subject is a derived view, never stored),
//   (d) validate the relation_type vocabulary (caused_by | confusable_with |
//       observed_in | experimental:<tag>) and the polymorphic endpoint kinds.
import { describe, expect, it } from 'vitest';
import { MisconceptionEdgeInsert, MisconceptionEdgeSchema } from './misconception-edge';

const VALID_EDGE = {
  id: 'mce_abc123',
  from_kind: 'misconception',
  from_id: 'misc_abc123',
  to_kind: 'knowledge',
  to_id: 'kc_xyz789',
  relation_type: 'caused_by',
  weight: 0.8,
  created_by: { by: 'ai', task_kind: 'misconception_propose' },
  proposed_by_ai: true,
  created_at: new Date('2026-06-30T00:00:00Z'),
  updated_at: new Date('2026-06-30T00:00:00Z'),
  archived_at: null,
};

describe('MisconceptionEdgeSchema (YUK-531, ADR-0036 RT1)', () => {
  it('parses a valid canonical caused_by edge row', () => {
    expect(MisconceptionEdgeSchema.safeParse(VALID_EDGE).success).toBe(true);
  });

  it('defaults weight to 1, proposed_by_ai to false, archived_at to null on insert', () => {
    const result = MisconceptionEdgeInsert.safeParse({
      id: 'mce_def456',
      from_kind: 'misconception',
      from_id: 'misc_def',
      to_kind: 'knowledge',
      to_id: 'kc_def',
      relation_type: 'caused_by',
      created_by: { by: 'user' },
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weight).toBe(1);
      expect(result.data.proposed_by_ai).toBe(false);
      expect(result.data.archived_at ?? null).toBe(null);
    }
  });

  // ADR-0035 red line — misconception edges are SOFT track. `.strict()` makes any
  // soft-track diagnostic key a hard parse failure (locks the invariant at the
  // schema boundary; `weight` is CONFIDENCE-only salience, never mastery).
  for (const softField of [
    'theta_hat',
    'theta',
    'pL',
    'p_l',
    'mastery',
    'mastery_state',
    'fsrs',
    'fsrs_state',
    'difficulty',
    'b',
  ]) {
    it(`REJECTS an edge carrying soft-track field \`${softField}\``, () => {
      const result = MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, [softField]: 0.5 });
      expect(result.success).toBe(false);
    });
  }

  // 项目铁律: subject 是派生视角，永远不进实体存储（effective_domain 派生）。
  it('REJECTS a `subject` field (subject is derived, never stored)', () => {
    expect(MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, subject: 'wenyan' }).success).toBe(
      false,
    );
  });

  it('REJECTS a `domain` field (no subject/domain column on the edge)', () => {
    expect(
      MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, domain: 'classical-chinese' }).success,
    ).toBe(false);
  });

  // archived_at is the ONLY time dimension — no bi-temporal valid_at/invalid_at.
  it('REJECTS bi-temporal valid_at/invalid_at fields', () => {
    expect(MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, valid_at: new Date() }).success).toBe(
      false,
    );
    expect(
      MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, invalid_at: new Date() }).success,
    ).toBe(false);
  });

  describe('relation_type vocabulary', () => {
    for (const rel of ['caused_by', 'confusable_with', 'observed_in', 'experimental:hypothesis']) {
      it(`accepts \`${rel}\``, () => {
        expect(
          MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, relation_type: rel }).success,
        ).toBe(true);
      });
    }

    it('REJECTS an unknown relation verb', () => {
      expect(
        MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, relation_type: 'prerequisite' }).success,
      ).toBe(false);
    });

    it('REJECTS a bare `experimental:` with an empty tag', () => {
      expect(
        MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, relation_type: 'experimental:' })
          .success,
      ).toBe(false);
    });
  });

  describe('polymorphic endpoint kinds', () => {
    for (const kind of ['misconception', 'knowledge', 'event']) {
      it(`accepts to_kind \`${kind}\``, () => {
        expect(MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, to_kind: kind }).success).toBe(
          true,
        );
      });
    }

    it('REJECTS an unknown endpoint kind (vocabulary is enum-bounded)', () => {
      expect(MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, to_kind: 'widget' }).success).toBe(
        false,
      );
      expect(
        MisconceptionEdgeSchema.safeParse({ ...VALID_EDGE, from_kind: 'widget' }).success,
      ).toBe(false);
    });
  });
});
