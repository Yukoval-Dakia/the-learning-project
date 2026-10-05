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

describe('EvaluationRecord — YUK-1096 P1-2 status/aggregate 一致性（矛盾态全拒）', () => {
  const base = {
    evaluation_id: 'ev_x',
    evaluation_group_id: 'eg_1',
    submission_id: 'sub_1',
    attempt: 1,
  };
  const scoredUnit = {
    status: 'scored' as const,
    scoring_unit_id: 'u_1',
    points_awarded: 3,
    scored_because: 'response' as const,
  };
  const pendingUnit = {
    status: 'pending' as const,
    scoring_unit_id: 'u_1',
    pending: { reason: 'needs_review' as const, trigger: 'flagged' as const },
  };

  it('accepts the three coherent states: pending+null, completed+resolved, completed+pending_units', () => {
    // pending：无任何聚合快照。
    const pendingRecord = EvaluationRecord.parse({
      ...base,
      status: 'pending',
      unit_results: [pendingUnit],
      aggregate: null,
    });
    expect(pendingRecord.status).toBe('pending');
    // completed + 全 scored + 总分。
    const done = EvaluationRecord.parse({
      ...base,
      status: 'completed',
      unit_results: [scoredUnit],
      aggregate: { kind: 'points_total', points: 3, policy: { kind: 'sum' } },
    });
    expect(done.status).toBe('completed');
    // completed + 存在 pending 单元 + 如实 unresolved(pending_units) —— terminal-pending
    // 是合法终态（evaluation.ts hasRetryable 语义），不得被判为矛盾。
    const terminalPending = EvaluationRecord.parse({
      ...base,
      status: 'completed',
      unit_results: [pendingUnit],
      aggregate: { kind: 'unresolved', reason: 'pending_units', detail: 'pending units: u_1' },
    });
    expect(terminalPending.aggregate).toMatchObject({ reason: 'pending_units' });
  });

  it('rejects pending carrying an aggregate — the evaluation is still open, no snapshot exists', () => {
    expect(() =>
      EvaluationRecord.parse({
        ...base,
        status: 'pending',
        unit_results: [scoredUnit],
        aggregate: { kind: 'points_total', points: 3, policy: { kind: 'sum' } },
      }),
    ).toThrow(/pending' must not carry an aggregate/);
    expect(() =>
      EvaluationRecord.parse({
        ...base,
        status: 'pending',
        unit_results: [pendingUnit],
        aggregate: { kind: 'unresolved', reason: 'pending_units', detail: 'x' },
      }),
    ).toThrow(/evaluation_status_contradiction/);
  });

  it('rejects completed with aggregate:null — a finished attempt always has a verdict shape', () => {
    expect(() =>
      EvaluationRecord.parse({
        ...base,
        status: 'completed',
        unit_results: [scoredUnit],
        aggregate: null,
      }),
    ).toThrow(/requires a non-null aggregate/);
  });

  it('rejects completed + pending units + aggregate:null — the original P1 contradiction', () => {
    expect(() =>
      EvaluationRecord.parse({
        ...base,
        status: 'completed',
        unit_results: [pendingUnit],
        aggregate: null,
      }),
    ).toThrow(/evaluation_status_contradiction/);
  });

  it('rejects completed + pending units masked by a resolved aggregate (points_total/level/no_mapping)', () => {
    for (const aggregate of [
      { kind: 'points_total', points: 3, policy: { kind: 'sum' } },
      { kind: 'level', level_id: 'l1', points: 5 },
      { kind: 'unresolved', reason: 'no_mapping', detail: 'claims mapping instead of pending' },
      { kind: 'unresolved', reason: 'invalid_result', detail: 'claims invalid instead of pending' },
    ]) {
      expect(() =>
        EvaluationRecord.parse({
          ...base,
          status: 'completed',
          unit_results: [pendingUnit],
          aggregate,
        }),
      ).toThrow(/must carry unresolved\(pending_units\)/);
    }
  });

  it('rejects completed + all-scored units claiming pending_units (stale aggregate lies the other way)', () => {
    expect(() =>
      EvaluationRecord.parse({
        ...base,
        status: 'completed',
        unit_results: [scoredUnit],
        aggregate: { kind: 'unresolved', reason: 'pending_units', detail: 'phantom pending' },
      }),
    ).toThrow(/claims pending_units but every unit result is scored/);
  });

  it('allows completed + all-scored + unresolved(no_mapping/invalid_result) — honest non-pending unresolved', () => {
    const record = EvaluationRecord.parse({
      ...base,
      status: 'completed',
      unit_results: [scoredUnit],
      aggregate: { kind: 'unresolved', reason: 'no_mapping', detail: 'unmapped level' },
    });
    expect(record.aggregate).toMatchObject({ kind: 'unresolved', reason: 'no_mapping' });
  });
});
