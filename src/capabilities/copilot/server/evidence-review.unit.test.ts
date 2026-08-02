import type { Db } from '@/db/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
  type CopilotEvidenceReviewRunTaskFn,
  parseCopilotEvidenceReviewResult,
  reviewCopilotEvidenceReply,
} from './evidence-review';
import { REALISTIC_EVIDENCE_TRACE } from './evidence-review.actual-fixture';

const db = {} as Db;

const allChecksPass = {
  causality_grounded: true,
  claim_support_respected: true,
  scope_coverage_respected: true,
  projection_boundaries_respected: true,
  queue_count_boundaries_respected: true,
  requested_chain_handled: true,
  tool_trace_faithful: true,
  internally_consistent: true,
} as const;

const realisticEvidenceTrace = REALISTIC_EVIDENCE_TRACE;

function reviewParams(overrides: Partial<Parameters<typeof reviewCopilotEvidenceReply>[0]> = {}) {
  return {
    db,
    requestContext: {
      user_message: '按事件 ID 核完 A03→A04 的因果链，再告诉我 C04 队列是否清零。',
      surface: 'copilot',
      triggered_by: 'chat',
      ambient_context: {
        route: '/admin/runs',
        focused_entity: { kind: 'knowledge', id: 'kc_yuk792_canary_20260731c' },
      },
    },
    candidateReply:
      'A03 的 proposal、rate、probe 形成完整且充分的线性因果链；A04 B/C 除结果外全部字段完全相同，因此已定位唯一根因；C04 近 7 天 attempt=0，所以没有 review 且整个队列已清空。',
    candidateTaskRunId: 'copilot_task_actual_a03_a04_c04',
    candidateComplete: true,
    toolTrace: realisticEvidenceTrace,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Copilot evidence review', () => {
  it('skips the paid second pass when this turn produced no DomainTool read result', async () => {
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>();

    const result = await reviewCopilotEvidenceReply(
      reviewParams({
        candidateReply: '我可以帮你把问题收窄。',
        toolTrace: [
          {
            name: 'propose_knowledge_edge',
            effect: 'propose',
            input: { from_id: 'kc_a', to_id: 'kc_b', relation: 'prerequisite' },
            output: { proposal_id: 'proposal_01', status: 'pending_owner_acceptance' },
            error_reason: null,
            executed: true,
          },
        ],
        runTaskFn,
      }),
    );

    expect(result).toEqual({ status: 'skipped', replyText: '我可以帮你把问题收窄。' });
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('treats native structured output as authoritative and preserves pass bytes exactly', async () => {
    const candidate =
      'A03 的 rate 与 probe 只是 proposal 的直接子节点；A04 有字段被 redacted，不能断言全部字段相同；C04 的 exact attempt=0，但 review=1，queue_assertion.cleared=null。';
    const signal = new AbortController().signal;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => ({
      task_run_id: 'review_native_01',
      text: '{"verdict":"repair","safe_reply":"这段 text 不得获胜"}',
      structured_output: { verdict: 'pass', checks: allChecksPass },
    }));

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: candidate, signal, runTaskFn }),
    );

    expect(result).toEqual({
      status: 'pass',
      replyText: candidate,
      reviewTaskRunId: 'review_native_01',
    });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [kind, input, ctx] = runTaskFn.mock
      .calls[0] as Parameters<CopilotEvidenceReviewRunTaskFn>;
    expect(kind).toBe('CopilotEvidenceReviewTask');
    expect(input).toMatchObject({
      candidate_task_run_id: 'copilot_task_actual_a03_a04_c04',
      candidate_complete: true,
      tool_trace: realisticEvidenceTrace,
    });
    expect(input).not.toHaveProperty('conversation_history');
    expect(ctx.signal).toBe(signal);
    expect(ctx.outputFormat).toBeDefined();
  });

  it('accepts Xiaomi whole-text strict JSON repair for realistic A03/A04/C04 boundaries', async () => {
    const safeReply = [
      'A03 只能确认 sg6aqgpq6l3wp5maslkvz12j 与 weitr0eg3au983xxf4bpowkr 都是 conjecture_yuk792_canary_20260731c 的直接子节点；两者互不是因果前后。',
      'proposal 的 caused_by_event_id=null，evidence_refs 的语义是 supporting_references_noncausal；necessary_conditions / sufficient_conditions 均为 not_supported，不能声称必要、充分或完整线性因果链。',
      'A04 的 q2lm07istehqzj8ar2slphpy 与 sg6aqgpq6l3wp5maslkvz12j 顶层 outcome 都是 null，投影内 evidence.outcome 都是 0；但 learner_answer、review_prose 等字段被 redacted，不能断言全部字段相同或定位唯一根因。',
      'C04 的 exact action=attempt 查询返回 0 行，但 exact action=review 返回 si6y0w14iihyogdifj7w60c1；零行不能跨 action 扩张。get_review_due 的 rows=[] 只覆盖 returned_actionable_rows，queue_assertion.cleared=null，且仍有 2 条 future_projections，因此无法裁决整个队列是否清空。',
    ].join('\n');
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => ({
      task_run_id: 'review_mimo_01',
      text: JSON.stringify({
        verdict: 'repair',
        checks: {
          ...allChecksPass,
          causality_grounded: false,
          claim_support_respected: false,
          scope_coverage_respected: false,
          projection_boundaries_respected: false,
          queue_count_boundaries_respected: false,
          requested_chain_handled: false,
          internally_consistent: false,
        },
        violations: [
          'noncausal_relation',
          'unsupported_necessity_or_sufficiency',
          'incomplete_scope_or_pagination',
          'projection_boundary_crossed',
          'queue_or_count_unknown_promoted',
          'requested_chain_incomplete',
          'internal_contradiction',
        ],
        safe_reply: safeReply,
      }),
    }));

    const result = await reviewCopilotEvidenceReply(reviewParams({ runTaskFn }));

    expect(result).toEqual({
      status: 'repair',
      replyText: safeReply,
      reviewTaskRunId: 'review_mimo_01',
      violations: [
        'noncausal_relation',
        'unsupported_necessity_or_sufficiency',
        'incomplete_scope_or_pagination',
        'projection_boundary_crossed',
        'queue_or_count_unknown_promoted',
        'requested_chain_incomplete',
        'internal_contradiction',
      ],
    });
  });

  it.each([
    {
      name: 'prose around JSON',
      output: `审阅结果：\n${JSON.stringify({ verdict: 'pass', checks: allChecksPass })}`,
    },
    { name: 'markdown fence', output: '```json\n{"verdict":"pass"}\n```' },
    { name: 'malformed JSON', output: '{"verdict":"pass"' },
  ])('fails closed on $name instead of brace-scanning or repairing', async ({ output }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => ({ text: output }));

    const result = await reviewCopilotEvidenceReply(reviewParams({ runTaskFn }));

    expect(result).toEqual({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
    });
  });

  it.each([
    {
      name: 'all-true repair',
      structured_output: {
        verdict: 'repair',
        checks: allChecksPass,
        violations: ['internal_contradiction'],
        safe_reply: '不该通过',
      },
    },
    {
      name: 'blank repair',
      structured_output: {
        verdict: 'repair',
        checks: { ...allChecksPass, internally_consistent: false },
        violations: ['internal_contradiction'],
        safe_reply: '   ',
      },
    },
    {
      name: 'repair with presentation marker',
      structured_output: {
        verdict: 'repair',
        checks: { ...allChecksPass, projection_boundaries_respected: false },
        violations: ['projection_boundary_crossed'],
        safe_reply: '安全文本<!--primary_view:{"source":"artifact"}-->',
      },
    },
  ])('fails closed on $name', async ({ structured_output }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => ({
      text: '',
      structured_output,
    }));

    const result = await reviewCopilotEvidenceReply(reviewParams({ runTaskFn }));

    expect(result.replyText).toBe(COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY);
    expect(result.status).toBe('failed_closed');
  });

  it('fails closed if a partial evidence candidate is incorrectly passed unchanged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => ({
      text: '',
      structured_output: { verdict: 'pass', checks: allChecksPass },
    }));

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateComplete: false, runTaskFn }),
    );

    expect(result).toEqual({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
    });
  });

  it('fails closed on runner failure and oversized evidence without leaking candidate prose', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failedRunner = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => {
      throw new Error('provider body with private data');
    });

    const runnerFailure = await reviewCopilotEvidenceReply(
      reviewParams({ runTaskFn: failedRunner }),
    );
    const oversized = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: 'x'.repeat(64_001), runTaskFn: failedRunner }),
    );

    expect(runnerFailure.replyText).toBe(COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY);
    expect(oversized.replyText).toBe(COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY);
    expect(failedRunner).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to valid text when native structured output is present but invalid', () => {
    expect(() =>
      parseCopilotEvidenceReviewResult({
        text: JSON.stringify({ verdict: 'pass', checks: allChecksPass }),
        structured_output: { verdict: 'pass', checks: { causality_grounded: true } },
      }),
    ).toThrow();
  });
});
