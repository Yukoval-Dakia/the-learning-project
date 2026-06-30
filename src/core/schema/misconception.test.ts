// YUK-454 increment-1 (ADR-0036 身份层) — misconception identity-table skeleton.
//
// RED-1 Zod contract. MisconceptionSchema is the canonical domain shape; it must
//   (a) parse a valid row,
//   (b) REJECT any soft-track diagnostic field bleeding in (theta/pL/mastery/
//       fsrs/difficulty) — ADR-0035 misconception is the SOFT track with NO
//       write path into the IRT/CDM/FSRS engines,
//   (c) REJECT a `subject` field — subject is a derived view, never stored
//       (项目铁律: 给实体加 subject 列是违例).
import { describe, expect, it } from 'vitest';
import { MisconceptionInsert, MisconceptionSchema } from './misconception';

const VALID_ROW = {
  id: 'misc_abc123',
  title: '把"使动用法"误判为"意动用法"',
  reasoning: '学生混淆了两种特殊动宾关系的语义方向',
  weight: 1,
  created_by: { by: 'ai', task_kind: 'misconception_propose' },
  proposed_by_ai: true,
  created_at: new Date('2026-06-18T00:00:00Z'),
  updated_at: new Date('2026-06-18T00:00:00Z'),
  archived_at: null,
};

describe('MisconceptionSchema (YUK-454 inc-1, ADR-0036 身份层)', () => {
  it('parses a valid canonical row', () => {
    const result = MisconceptionSchema.safeParse(VALID_ROW);
    expect(result.success).toBe(true);
  });

  it('accepts null reasoning (optional explanatory text)', () => {
    const result = MisconceptionSchema.safeParse({ ...VALID_ROW, reasoning: null });
    expect(result.success).toBe(true);
  });

  it('defaults weight to 1 and proposed_by_ai to false on insert', () => {
    const result = MisconceptionInsert.safeParse({
      id: 'misc_def456',
      title: 'x',
      created_by: { by: 'user' },
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weight).toBe(1);
      expect(result.data.proposed_by_ai).toBe(false);
    }
  });

  // ADR-0035 red line — misconception is SOFT track. No soft-track diagnostic
  // field may live on the identity row. strict() makes any such key a hard parse
  // failure (locks the invariant at the schema boundary).
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
    it(`REJECTS a row carrying soft-track field \`${softField}\``, () => {
      const result = MisconceptionSchema.safeParse({ ...VALID_ROW, [softField]: 0.5 });
      expect(result.success).toBe(false);
    });
  }

  // 项目铁律: subject 是派生视角，永远不进实体存储（effective_domain 派生）。
  it('REJECTS a `subject` field (subject is derived, never stored)', () => {
    const result = MisconceptionSchema.safeParse({ ...VALID_ROW, subject: 'wenyan' });
    expect(result.success).toBe(false);
  });

  it('REJECTS a `domain` field (no subject/domain column on misconception)', () => {
    const result = MisconceptionSchema.safeParse({ ...VALID_ROW, domain: 'classical-chinese' });
    expect(result.success).toBe(false);
  });
});

// YUK-531 (A5 S4 / RT1) — promotion lifecycle/provenance columns. Value-level
// constraints, not just default-presence: status/source are bounded enums (NOT
// free text), seen is a non-negative int, evidence is a string array.
describe('MisconceptionSchema — YUK-531 RT1 lifecycle/provenance columns', () => {
  it('accepts draft|active status and hard|soft source', () => {
    for (const status of ['draft', 'active'] as const) {
      for (const source of ['hard', 'soft'] as const) {
        const result = MisconceptionSchema.safeParse({ ...VALID_ROW, status, source, seen: 3 });
        expect(result.success).toBe(true);
      }
    }
  });

  it('REJECTS status `fading` (read-model display projection, NOT a stored enum)', () => {
    expect(MisconceptionSchema.safeParse({ ...VALID_ROW, status: 'fading' }).success).toBe(false);
    expect(MisconceptionSchema.safeParse({ ...VALID_ROW, status: 'retracted' }).success).toBe(
      false,
    );
  });

  it('REJECTS a third source track (only 硬轨 hard | 软轨 soft)', () => {
    expect(MisconceptionSchema.safeParse({ ...VALID_ROW, source: 'medium' }).success).toBe(false);
  });

  it('REJECTS a negative or non-integer seen count', () => {
    expect(MisconceptionSchema.safeParse({ ...VALID_ROW, seen: -1 }).success).toBe(false);
    expect(MisconceptionSchema.safeParse({ ...VALID_ROW, seen: 1.5 }).success).toBe(false);
  });

  it('defaults status→draft, source→soft, seen→0, evidence→[] on insert', () => {
    const result = MisconceptionInsert.safeParse({
      id: 'misc_rt1',
      title: 'x',
      created_by: { by: 'user' },
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('draft');
      expect(result.data.source).toBe('soft');
      expect(result.data.seen).toBe(0);
      expect(result.data.evidence).toEqual([]);
    }
  });
});
