import { describe, expect, it } from 'vitest';
import type { ToolExecutionResultObservation } from '@/kernel/tools/types';
import { segmentEvidenceReply, segmentEvidenceRequest } from './evidence-contract';
import { REALISTIC_EVIDENCE_TRACE } from './evidence-review.actual-fixture';
import {
  type CopilotEvidenceLedgerRecord,
  buildCopilotEvidenceSourceCatalog,
  createComparisonEvidenceSubmission,
  createReferenceEvidenceSubmission,
  projectCopilotEvidenceModelTrace,
  projectCopilotEvidenceSourceCatalog,
} from './evidence-submission';

const COMPLEX_TRACE = [...REALISTIC_EVIDENCE_TRACE, ...REALISTIC_EVIDENCE_TRACE.slice(0, 8)];

const requestContext = {
  user_message:
    '核验 A01 的因果边界；核验 A03 的激活证据；核验 A04 的投影范围；核验 C01 的复习链；核验 C04 队列是否清零；最后说明本轮是否只读。',
};

describe('Copilot evidence incremental submission', () => {
  it('preserves the server-owned proposal effect contract in the sealed model trace', () => {
    const proposalTrace = [
      {
        name: 'propose_learning_item_archive',
        effect: 'propose' as const,
        input: { learning_item_id: 'item_b' },
        output: { status: 'proposed', proposal_id: 'proposal_b' },
        error_reason: null,
        executed: true,
        proposal_effect_contract: {
          owner_gate: 'FULL' as const,
          direct_write: false as const,
          rollback: 'dismiss_before_accept' as const,
        },
      },
    ];

    const modelTrace = projectCopilotEvidenceModelTrace(proposalTrace, []);

    expect(modelTrace).toEqual([
      {
        call_index: 0,
        tool_name: 'propose_learning_item_archive',
        effect: 'propose',
        status: 'unusable',
        executed: true,
        error_reason: null,
        proposal_effect_contract: {
          owner_gate: 'FULL',
          direct_write: false,
          rollback: 'dismiss_before_accept',
        },
      },
    ]);
  });

  it('canonicalizes a 21-call, 55KB+ blind reference from bounded append-only records', () => {
    expect(COMPLEX_TRACE).toHaveLength(21);
    expect(JSON.stringify(COMPLEX_TRACE).length).toBeGreaterThan(55_000);

    const requestUnits = segmentEvidenceRequest(requestContext);
    const sourceCatalog = buildCopilotEvidenceSourceCatalog(COMPLEX_TRACE);
    const compactCatalog = projectCopilotEvidenceSourceCatalog(sourceCatalog, COMPLEX_TRACE.length);
    const modelTrace = projectCopilotEvidenceModelTrace(COMPLEX_TRACE, sourceCatalog);
    const outputSources = sourceCatalog.filter((source) => source.side === 'output');
    expect(outputSources.length).toBeGreaterThan(100);
    expect(JSON.stringify(compactCatalog).length).toBeLessThan(
      JSON.stringify(sourceCatalog).length * 0.6,
    );
    const oldModelInputChars = JSON.stringify({
      tool_trace: COMPLEX_TRACE,
      source_catalog: compactCatalog,
    }).length;
    expect(JSON.stringify(modelTrace).length).toBeLessThan(oldModelInputChars * 0.6);
    const firstEventId = sourceCatalog.find(
      (source) =>
        source.call_index === 0 &&
        source.side === 'output' &&
        source.json_pointer === '/events/0/id',
    );
    expect(firstEventId).toBeDefined();
    expect(JSON.stringify(modelTrace[0]?.output)).toContain(
      JSON.stringify([firstEventId?.source_id, 'conjecture_yuk792_canary_20260731c']),
    );

    const submission = createReferenceEvidenceSubmission({
      requestUnits,
      toolTrace: COMPLEX_TRACE,
      sourceCatalog,
    });
    const usedCalls = new Set<number>();
    for (const unit of requestUnits) {
      const source = outputSources.find((entry) => !usedCalls.has(entry.call_index));
      expect(source).toBeDefined();
      if (!source) throw new Error('fixture source missing');
      usedCalls.add(source.call_index);
      expect(
        submission.appendEvidencePoints({
          points: [
            {
              request_unit_indices: [unit.index],
              kind: 'observed_fact',
              statement_md: `请求 ${unit.index} 仅绑定到本轮实际只读结果，并保留 typed scope。`,
              sources: [{ source_id: source.source_id, role: 'value' }],
            },
          ],
        }),
      ).toMatchObject({ ok: true });
    }

    const unusedSuccessfulReads = COMPLEX_TRACE.flatMap((observation, callIndex) =>
      observation.effect === 'read' &&
      observation.executed &&
      observation.error_reason === null &&
      !usedCalls.has(callIndex)
        ? [{ call_index: callIndex, rationale_md: '与本次六个请求单元重复或不直接相关。' }]
        : [],
    );
    expect(
      submission.markTraceCallsNotMaterial({ calls: unusedSuccessfulReads.slice(0, 12) }),
    ).toMatchObject({ ok: true });
    expect(
      submission.markTraceCallsNotMaterial({ calls: unusedSuccessfulReads.slice(12) }),
    ).toMatchObject({ ok: true });
    expect(
      submission.setSafeReply({
        safe_reply:
          'A01、A03、A04、C01、C04 均只按本轮 typed reader 的实际字段与范围作答；任何未穷尽投影、非因果引用或未知队列计数都明确保留为缺口。本轮 21 次 observation 均为只读，没有 propose/write。',
      }),
    ).toMatchObject({ ok: true, auto_completed: true });

    // Explicit completion remains an idempotent compatibility/recovery tool;
    // the final accepted append already performed the canonical seal.
    const completed = submission.completeReference();
    expect(completed).toMatchObject({
      ok: true,
      evidence_point_count: requestUnits.length,
      trace_call_count: COMPLEX_TRACE.length,
    });
    const reference = submission.completedReference();
    expect(reference?.output.evidence_points.map((point) => point.point_index)).toEqual(
      requestUnits.map((unit) => unit.index),
    );
    expect(reference?.output.request_coverage).toHaveLength(requestUnits.length);
    expect(reference?.output.trace_coverage).toHaveLength(COMPLEX_TRACE.length);
    expect(JSON.stringify(reference?.output)).toContain('json_pointer');
  });

  it('derives comparator request coverage and verdict from small per-reply checks', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验事实 A；核验事实 B。' });
    const toolTrace = REALISTIC_EVIDENCE_TRACE.slice(0, 2);
    const sourceCatalog = buildCopilotEvidenceSourceCatalog(toolTrace);
    const submission = createReferenceEvidenceSubmission({
      requestUnits,
      toolTrace,
      sourceCatalog,
    });
    for (const unit of requestUnits) {
      const source = sourceCatalog.find(
        (entry) => entry.call_index === unit.index && entry.side === 'output',
      );
      if (!source) throw new Error('fixture source missing');
      submission.appendEvidencePoints({
        points: [
          {
            request_unit_indices: [unit.index],
            kind: 'observed_fact',
            statement_md: `事实 ${unit.index} 由实际 reader 输出支持。`,
            sources: [{ source_id: source.source_id, role: 'value' }],
          },
        ],
      });
    }
    submission.setSafeReply({ safe_reply: '事实 A 已核验。事实 B 已核验。' });
    expect(submission.completeReference()).toMatchObject({ ok: true });
    const reference = submission.completedReference();
    if (!reference) throw new Error('reference missing');

    const selectedReply = '事实 A 已核验。事实 B 已核验。';
    const replyUnits = segmentEvidenceReply(selectedReply);
    const comparison = createComparisonEvidenceSubmission({
      requestUnits,
      replyUnits,
      selectedReply,
      reference,
      toolTrace,
      sourceComplete: true,
    });
    expect(
      comparison.appendReplyChecks({
        checks: replyUnits.map((unit) => ({
          reply_unit_index: unit.index,
          request_unit_indices: [unit.index],
          status: 'supported' as const,
          evidence_point_indices: [unit.index],
          reason_codes: ['supported' as const],
        })),
      }),
    ).toMatchObject({ ok: true, auto_completed: true, verdict: 'pass' });
    expect(comparison.completeComparison()).toMatchObject({ ok: true, verdict: 'pass' });
    expect(comparison.completedComparison()?.output.request_checks).toEqual([
      {
        request_unit_index: 0,
        status: 'answered',
        reply_unit_indices: [0],
        evidence_point_indices: [0],
        reason_codes: ['supported'],
      },
      {
        request_unit_index: 1,
        status: 'answered',
        reply_unit_indices: [1],
        evidence_point_indices: [1],
        reason_codes: ['supported'],
      },
    ]);
  });

  it('rejects an unknown short source id atomically instead of asking for a JSON pointer', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验事实。' });
    const toolTrace = REALISTIC_EVIDENCE_TRACE.slice(0, 1);
    const sourceCatalog = buildCopilotEvidenceSourceCatalog(toolTrace);
    const submission = createReferenceEvidenceSubmission({
      requestUnits,
      toolTrace,
      sourceCatalog,
    });

    expect(
      submission.appendEvidencePoints({
        points: [
          {
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: '这条记录不能被接受。',
            sources: [{ source_id: 's999999', role: 'value' }],
          },
        ],
      }),
    ).toEqual({ ok: false, reason: 'unknown_source_id' });
    expect(submission.progress()).toMatchObject({ evidence_point_count: 0 });
  });
});

describe('not-material batch submission contract (YUK-926)', () => {
  const mark = (callIndex: number, rationale = '与本次请求单元不直接相关。') => ({
    call_index: callIndex,
    rationale_md: rationale,
  });

  const setup = (toolTrace?: readonly ToolExecutionResultObservation[]) => {
    const trace = toolTrace ?? REALISTIC_EVIDENCE_TRACE.slice(0, 6);
    const submission = createReferenceEvidenceSubmission({
      requestUnits: segmentEvidenceRequest({ user_message: '核验批量 not-material 提交契约。' }),
      toolTrace: trace,
      sourceCatalog: buildCopilotEvidenceSourceCatalog(trace),
    });
    const records: CopilotEvidenceLedgerRecord[] = [];
    submission.setAppendListener((record) => {
      records.push(record);
    });
    return { submission, records };
  };

  it('accepts one batch of N marks as a single ordered ledger record and counts every call', () => {
    const { submission, records } = setup();
    const calls = [mark(4, '重复查询，不承担新事实。'), mark(2, '范围已被 s0 覆盖。'), mark(0)];
    expect(submission.markTraceCallsNotMaterial({ calls })).toMatchObject({
      ok: true,
      not_material_call_count: 3,
    });
    // One accepted invocation appends exactly one ledger record carrying the
    // calls in submission order; per-call state never collapses.
    expect(records).toEqual([{ kind: 'trace_calls_not_material', calls }]);
    expect(submission.resumeState().not_material_call_indices).toEqual([0, 2, 4]);
  });

  it('accepts a single-call batch with identical semantics to one-item invocations', () => {
    const { submission, records } = setup();
    expect(submission.markTraceCallsNotMaterial({ calls: [mark(5)] })).toMatchObject({
      ok: true,
      not_material_call_count: 1,
    });
    expect(records).toEqual([{ kind: 'trace_calls_not_material', calls: [mark(5)] }]);
    expect(submission.resumeState().not_material_call_indices).toEqual([5]);
  });

  it('replays identical invocations from the accepted cache and rejects cross-batch repeats atomically', () => {
    const { submission, records } = setup();
    const first = submission.markTraceCallsNotMaterial({ calls: [mark(1), mark(3)] });
    expect(first).toMatchObject({ ok: true, not_material_call_count: 2 });
    // Same content returns the cached accepted result without a new record.
    expect(submission.markTraceCallsNotMaterial({ calls: [mark(1), mark(3)] })).toBe(first);
    // A batch repeating an accepted call is rejected whole; nothing partial lands.
    expect(submission.markTraceCallsNotMaterial({ calls: [mark(4), mark(3)] })).toEqual({
      ok: false,
      reason: 'duplicate_trace_call',
    });
    expect(submission.progress().not_material_call_count).toBe(2);
    expect(records).toHaveLength(1);
  });

  it('rejects a mixed batch containing one invalid call id atomically', () => {
    const { submission, records } = setup();
    // In-trace-schema index that exceeds the actual 6-call trace bounds.
    expect(submission.markTraceCallsNotMaterial({ calls: [mark(2), mark(40)] })).toEqual({
      ok: false,
      reason: 'invalid_trace_call_indices',
    });
    // A within-batch duplicate hits the same bounded contract.
    expect(submission.markTraceCallsNotMaterial({ calls: [mark(2), mark(2)] })).toEqual({
      ok: false,
      reason: 'invalid_trace_call_indices',
    });
    // An index beyond the schema bound fails validation before trace checks.
    expect(submission.markTraceCallsNotMaterial({ calls: [mark(2), mark(999)] })).toEqual({
      ok: false,
      reason: 'invalid_submission_shape',
    });
    expect(submission.progress().not_material_call_count).toBe(0);
    expect(records).toHaveLength(0);
  });

  it('rejects an empty calls array with the invalid submission shape contract', () => {
    const { submission } = setup();
    expect(submission.markTraceCallsNotMaterial({ calls: [] })).toEqual({
      ok: false,
      reason: 'invalid_submission_shape',
    });
    expect(submission.progress().not_material_call_count).toBe(0);
  });

  it('rejects a batch that mixes a valid call with a non-successful read atomically', () => {
    const failedRead: ToolExecutionResultObservation = {
      name: 'query_events',
      effect: 'read',
      input: { filter: { subject_id: 'subject_missing' } },
      output: { events: [] },
      executed: false,
      error_reason: 'domain_reader_failed',
    };
    const { submission, records } = setup([...REALISTIC_EVIDENCE_TRACE.slice(0, 2), failedRead]);
    expect(submission.markTraceCallsNotMaterial({ calls: [mark(0), mark(2)] })).toEqual({
      ok: false,
      reason: 'not_material_requires_successful_read',
    });
    expect(submission.progress().not_material_call_count).toBe(0);
    expect(records).toHaveLength(0);
  });
});
