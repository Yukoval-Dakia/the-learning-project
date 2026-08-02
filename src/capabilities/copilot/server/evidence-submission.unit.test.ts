import { describe, expect, it } from 'vitest';
import { segmentEvidenceReply, segmentEvidenceRequest } from './evidence-contract';
import { REALISTIC_EVIDENCE_TRACE } from './evidence-review.actual-fixture';
import {
  buildCopilotEvidenceSourceCatalog,
  createComparisonEvidenceSubmission,
  createReferenceEvidenceSubmission,
  projectCopilotEvidenceSourceCatalog,
} from './evidence-submission';

const COMPLEX_TRACE = [...REALISTIC_EVIDENCE_TRACE, ...REALISTIC_EVIDENCE_TRACE.slice(0, 8)];

const requestContext = {
  user_message:
    '核验 A01 的因果边界；核验 A03 的激活证据；核验 A04 的投影范围；核验 C01 的复习链；核验 C04 队列是否清零；最后说明本轮是否只读。',
};

describe('Copilot evidence incremental submission', () => {
  it('canonicalizes a 21-call, 55KB+ blind reference from bounded append-only records', () => {
    expect(COMPLEX_TRACE).toHaveLength(21);
    expect(JSON.stringify(COMPLEX_TRACE).length).toBeGreaterThan(55_000);

    const requestUnits = segmentEvidenceRequest(requestContext);
    const sourceCatalog = buildCopilotEvidenceSourceCatalog(COMPLEX_TRACE);
    const compactCatalog = projectCopilotEvidenceSourceCatalog(sourceCatalog, COMPLEX_TRACE.length);
    const outputSources = sourceCatalog.filter((source) => source.side === 'output');
    expect(outputSources.length).toBeGreaterThan(100);
    expect(JSON.stringify(compactCatalog).length).toBeLessThan(
      JSON.stringify(sourceCatalog).length * 0.6,
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
    ).toEqual({ ok: true });

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
    ).toMatchObject({ ok: true });
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
