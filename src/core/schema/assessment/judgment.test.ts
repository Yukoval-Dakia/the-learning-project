// YUK-1046 — 判分记录契约测试：显式未决态（非伪零分）、幂等冲突、评估尝试身份。

import { describe, expect, it } from 'vitest';

import {
  EvaluationRecord,
  HistoricalUnknownSubmission,
  PendingUnitResult,
  SubmissionRecord,
  type SubmissionRecordT,
  resolveSubmissionIdempotency,
} from './judgment';

function submission(overrides: Partial<SubmissionRecordT> = {}): SubmissionRecordT {
  return {
    submission_id: 'sub_1',
    issuance_id: 'iss_1',
    revision_id: 'rev_1',
    evaluation_group_id: 'eg_1',
    response_set: {
      entries: [
        { slot_id: 'q1', kind: 'choice', option_ids: ['o1'] },
        { slot_id: 'essay', kind: 'open', text_md: '我的证明……', evidence: [] },
      ],
    },
    group_evidence: [],
    idempotency_key: 'idem-1',
    submitted_at: '2026-09-25T08:00:00.000Z',
    ...overrides,
  };
}

describe('SubmissionRecord — 新 runtime 身份必填', () => {
  it('rejects missing issuance/revision/evaluation_group ids (no optional escape hatch)', () => {
    const valid = submission();
    expect(() => SubmissionRecord.parse({ ...valid, issuance_id: undefined })).toThrow();
    expect(() => SubmissionRecord.parse({ ...valid, revision_id: undefined })).toThrow();
    expect(() => SubmissionRecord.parse({ ...valid, evaluation_group_id: undefined })).toThrow();
  });

  it('historical unknown is its own explicit record type, not an optional field', () => {
    const record = HistoricalUnknownSubmission.parse({
      record_kind: 'historical_unknown',
      source_kind: 'paper_answer',
      source_id: 'pa_4821',
      source_locator: 'paper.pt-slots[3]',
      note: '无 issued snapshot —— 不得用当前 revision 补造当时所见',
    });
    expect(record.record_kind).toBe('historical_unknown');
    expect(() =>
      HistoricalUnknownSubmission.parse({
        record_kind: 'historical_unknown',
        source_kind: 'paper_answer',
        source_id: 'pa_4821',
        // locator 缺失 —— 历史映射 locator 非空（§3.2）
      }),
    ).toThrow();
  });
});

describe('resolveSubmissionIdempotency — 同 key 不同载荷 ⇒ 冲突', () => {
  it('byte-identical frozen payload replays as same_payload', () => {
    expect(resolveSubmissionIdempotency(submission(), submission())).toEqual({
      outcome: 'same_payload',
    });
  });

  it('different revision under the same key conflicts with revision_changed', () => {
    expect(
      resolveSubmissionIdempotency(submission(), submission({ revision_id: 'rev_2' })),
    ).toEqual({ outcome: 'conflict', reason: 'revision_changed' });
  });

  it('different answers/attachments under the same key conflict with response_changed', () => {
    const changed = submission({
      response_set: {
        entries: [
          { slot_id: 'q1', kind: 'choice', option_ids: ['o2'] },
          { slot_id: 'essay', kind: 'open', text_md: '我的证明……', evidence: [] },
        ],
      },
    });
    expect(resolveSubmissionIdempotency(submission(), changed)).toEqual({
      outcome: 'conflict',
      reason: 'response_changed',
    });
  });

  it('refuses to compare different idempotency keys (caller bug, not a policy outcome)', () => {
    expect(() =>
      resolveSubmissionIdempotency(submission(), submission({ idempotency_key: 'idem-2' })),
    ).toThrow();
  });

  it('P1-7: same key + same answers under a DIFFERENT issuance is a conflict, not a replay', () => {
    expect(
      resolveSubmissionIdempotency(submission(), submission({ issuance_id: 'iss_other' })),
    ).toEqual({ outcome: 'conflict', reason: 'issuance_mismatch' });
  });

  it('P1-7: same key + same answers under a DIFFERENT evaluation group is a conflict', () => {
    expect(
      resolveSubmissionIdempotency(submission(), submission({ evaluation_group_id: 'eg_other' })),
    ).toEqual({ outcome: 'conflict', reason: 'evaluation_group_mismatch' });
  });

  it('P1-6: same key + same slots but different group evidence is a conflict (payload changed)', () => {
    const withEvidence = submission({
      group_evidence: [
        {
          evidence: {
            evidence_id: 'ev_page',
            kind: 'image',
            asset: { asset_id: 'ast_page', digest: 'sha256:page' },
            mime_type: 'image/jpeg',
            bytes: 900_000,
            uploaded_at: '2026-09-25T08:00:00.000Z',
          },
          target: { scope: 'all_units' },
        },
      ],
    });
    expect(resolveSubmissionIdempotency(withEvidence, submission())).toEqual({
      outcome: 'conflict',
      reason: 'response_changed',
    });
    expect(resolveSubmissionIdempotency(withEvidence, withEvidence)).toEqual({
      outcome: 'same_payload',
    });
  });
});

describe('未决态 —— 显式类型，不是伪零分', () => {
  it('every §4.4 pending reason parses as a distinct PendingUnitResult', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing_response', { slot_ids: ['q1'] }],
      ['missing_materials', { material_ids: ['mat_fig'] }],
      ['unparseable_response', { slot_id: 'num_1', detail: '数值槽收到 "约 9.8 米每秒"' }],
      ['unreadable_evidence', { evidence_ids: ['ev_1'], detail: 'PDF 解码失败' }],
      ['insufficient_evidence', { detail: '只有转写文本，需原音频证据' }],
      ['unjudgeable', { detail: '原媒体音高分析能力切片未准入' }],
      ['needs_review', { trigger: 'verify_suspended', detail: '题源 verify 挂起期间的提交' }],
      ['infra_failure', { retryable: true, detail: 'provider 529' }],
      ['historical_unresolved', { detail: '迁移前记录缺冻结上下文' }],
    ];
    for (const [reason, payload] of cases) {
      const result = PendingUnitResult.parse({
        status: 'pending',
        scoring_unit_id: 'u_1',
        pending: { reason, ...payload },
      });
      expect(result.pending.reason).toBe(reason);
    }
  });

  it('a pending unit cannot carry a score — extra keys are stripped and absent from the type', () => {
    const result = PendingUnitResult.parse({
      status: 'pending',
      scoring_unit_id: 'u_1',
      pending: { reason: 'missing_materials', material_ids: ['m1'] },
      points_awarded: 0, // 未决态没有分数字段 —— 被 schema 剔除
    });
    expect(result).not.toHaveProperty('points_awarded');
    expect(Object.keys(result).sort()).toEqual(['pending', 'scoring_unit_id', 'status']);
  });

  it('scored blank is explicit (scored_because=blank_marked_zero), distinct from pending missing', () => {
    const record = EvaluationRecord.parse({
      evaluation_id: 'ev_1',
      evaluation_group_id: 'eg_1',
      submission_id: 'sub_1',
      attempt: 1,
      status: 'completed',
      unit_results: [
        {
          status: 'scored',
          scoring_unit_id: 'u_blank',
          points_awarded: 0,
          scored_because: 'blank_marked_zero',
        },
        {
          status: 'pending',
          scoring_unit_id: 'u_missing',
          pending: { reason: 'missing_response', slot_ids: ['q1'] },
        },
      ],
      aggregate: {
        kind: 'unresolved',
        reason: 'pending_units',
        detail: 'pending units: u_missing',
      },
    });
    expect(record.unit_results[0]).toMatchObject({ status: 'scored', points_awarded: 0 });
    expect(record.unit_results[1]).toMatchObject({ status: 'pending' });
    expect(record.aggregate).toMatchObject({ kind: 'unresolved', reason: 'pending_units' });
  });
});
