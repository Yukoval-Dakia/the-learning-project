import type { Db } from '@/db/client';
import { queryKnowledgeTool } from '@/server/ai/tools/knowledge-readers';
import { queryEventsTool } from '@/server/ai/tools/query-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
  type CopilotEvidenceReviewRunTaskFn,
  parseCopilotEvidenceReviewResult,
  parseCopilotEvidenceVerificationResult,
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
    candidateReply: [
      'A01 的 query_knowledge 返回空，所以三个 KC 从未挂载且只存在于事件日志；direct_children=[] 也证明没有 review/judge。',
      'A03 的 proposal、rate、probe 形成完整且充分的线性因果链；exact subjectId 首页完整，说明产品数据库不存在 intervention。',
      'A04 B/C 除结果外全部字段完全相同，因此已定位唯一根因。',
      'C01 是系统唯一一条 review 链；相同 timestamp 与连续 dispatch_seq 证明同一事务，immediate card 已被清理。',
      'C04 近 7 天 attempt=0，never_reviewed_count=0，所以没有 review、没有任何到期项目且整个队列已清空。',
    ].join('\n'),
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
  it('keeps realistic query fixtures valid against the current typed reader schemas', () => {
    for (const observation of realisticEvidenceTrace) {
      if (observation.name === 'query_events') {
        expect(queryEventsTool.outputSchema.safeParse(observation.output).success).toBe(true);
      }
      if (observation.name === 'query_knowledge') {
        expect(queryKnowledgeTool.outputSchema.safeParse(observation.output).success).toBe(true);
      }
    }
  });

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

  it('preserves candidate bytes only after two independent passes over the exact trace', async () => {
    const candidate =
      'A03 的 rate 与 probe 只是 proposal 的直接子节点；A04 有字段被 redacted，不能断言全部字段相同；C04 的 exact attempt=0，但 review=1，queue_assertion.cleared=null。';
    const signal = new AbortController().signal;
    const runTaskFn = vi
      .fn<CopilotEvidenceReviewRunTaskFn>()
      .mockResolvedValueOnce({
        task_run_id: 'review_native_01',
        text: '{"verdict":"repair","safe_reply":"这段 text 不得获胜"}',
        structured_output: { verdict: 'pass', checks: allChecksPass },
      })
      .mockResolvedValueOnce({
        task_run_id: 'review_verify_01',
        text: '',
        structured_output: { verdict: 'certify', checks: allChecksPass },
      });

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: candidate, signal, runTaskFn }),
    );

    expect(result).toEqual({
      status: 'pass',
      replyText: candidate,
      reviewTaskRunId: 'review_native_01',
      verificationTaskRunId: 'review_verify_01',
    });
    expect(runTaskFn).toHaveBeenCalledTimes(2);
    const [kind, input, ctx] = runTaskFn.mock
      .calls[0] as Parameters<CopilotEvidenceReviewRunTaskFn>;
    expect(kind).toBe('CopilotEvidenceReviewTask');
    expect(input).toMatchObject({
      candidate_task_run_id: 'copilot_task_actual_a03_a04_c04',
      candidate_complete: true,
      review_round: 'initial',
      tool_trace: realisticEvidenceTrace,
    });
    expect(input).not.toHaveProperty('conversation_history');
    expect(ctx.signal).toBe(signal);
    expect(ctx.outputFormat).toBeDefined();
    expect(runTaskFn.mock.calls[1]?.[0]).toBe('CopilotEvidenceVerificationTask');
    expect(runTaskFn.mock.calls[1]?.[1]).toMatchObject({
      final_reply: candidate,
      final_text_kind: 'original',
      source_complete: true,
      tool_trace: realisticEvidenceTrace,
    });
    expect(runTaskFn.mock.calls[1]?.[1]).not.toHaveProperty('candidate_task_run_id');
    expect(runTaskFn.mock.calls[1]?.[1]).not.toHaveProperty('selected_by_initial_verdict');
  });

  it('shows a realistic repair only after a second pass validates it', async () => {
    const safeReply = [
      'A03 只能确认 sg6aqgpq6l3wp5maslkvz12j 与 weitr0eg3au983xxf4bpowkr 都是 conjecture_yuk792_canary_20260731c 的直接子节点；两者互不是因果前后。',
      'proposal 的 caused_by_event_id=null，evidence_refs 的语义是 supporting_references_noncausal；necessary_conditions / sufficient_conditions 均为 not_supported，不能声称必要、充分或完整线性因果链。',
      'A04 的 q2lm07istehqzj8ar2slphpy 与 sg6aqgpq6l3wp5maslkvz12j 顶层 outcome 都是 null，投影内 evidence.outcome 都是 0；但 learner_answer、review_prose 等字段被 redacted，不能断言全部字段相同或定位唯一根因。',
      'query_knowledge 的 active effective-domain 查询返回空，只表示本次 domain/node scope 没有 active match，不证明节点从未存在、从未挂载或只存在于 event log。相同 timestamp 与 dispatch_seq 只支持插入顺序，不证明同一事务；180 天完整窗口也不支持“系统唯一”。',
      'C04 的 exact action=attempt 查询返回 0 行，但 exact action=review 返回 si6y0w14iihyogdifj7w60c1；零行不能跨 action 扩张。get_review_due 的 rows=[] 只覆盖 returned_actionable_rows，queue_assertion.cleared=null，且仍有 2 条 future_projections，因此无法裁决整个队列是否清空。',
    ].join('\n');
    const violations = [
      'noncausal_relation',
      'unsupported_necessity_or_sufficiency',
      'incomplete_scope_or_pagination',
      'projection_boundary_crossed',
      'queue_or_count_unknown_promoted',
      'requested_chain_incomplete',
      'internal_contradiction',
    ] as const;
    const runTaskFn = vi
      .fn<CopilotEvidenceReviewRunTaskFn>()
      .mockResolvedValueOnce({
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
          violations,
          safe_reply: safeReply,
        }),
      })
      .mockResolvedValueOnce({
        task_run_id: 'review_mimo_verify_01',
        text: JSON.stringify({ verdict: 'certify', checks: allChecksPass }),
      });

    const result = await reviewCopilotEvidenceReply(reviewParams({ runTaskFn }));

    expect(result).toEqual({
      status: 'repair',
      replyText: safeReply,
      reviewTaskRunId: 'review_mimo_01',
      verificationTaskRunId: 'review_mimo_verify_01',
      violations,
    });
    expect(runTaskFn.mock.calls[1]?.[0]).toBe('CopilotEvidenceVerificationTask');
    expect(runTaskFn.mock.calls[1]?.[1]).toMatchObject({
      final_reply: safeReply,
      final_text_kind: 'repair',
      source_complete: true,
    });
  });

  it('fails closed instead of showing an unverified repair of a complex bounded trace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unsafeRepair = [
      'get_review_due 返回 0，所以当前没有任何到期项目。',
      'subjectId 完整窗口没有 intervention，因此产品数据库中不存在 intervention。',
    ].join('\n');
    const runTaskFn = vi
      .fn<CopilotEvidenceReviewRunTaskFn>()
      .mockResolvedValueOnce({
        task_run_id: 'review_unsafe_repair_01',
        text: JSON.stringify({
          verdict: 'repair',
          checks: { ...allChecksPass, scope_coverage_respected: false },
          violations: ['incomplete_scope_or_pagination'],
          safe_reply: unsafeRepair,
        }),
      })
      .mockResolvedValueOnce({
        task_run_id: 'review_unsafe_repair_verify_01',
        text: JSON.stringify({
          verdict: 'reject',
          checks: {
            ...allChecksPass,
            scope_coverage_respected: false,
            queue_count_boundaries_respected: false,
          },
          violations: ['incomplete_scope_or_pagination', 'queue_or_count_unknown_promoted'],
        }),
      });

    const result = await reviewCopilotEvidenceReply(reviewParams({ runTaskFn }));

    expect(result).toEqual({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
    });
    expect(JSON.stringify(result)).not.toContain(unsafeRepair);
  });

  it('fails closed when a repair evades material request parts despite a rich trace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evasiveRepair = '现有证据不足，A03/A04 链和 C04 队列都无法裁决。';
    const runTaskFn = vi
      .fn<CopilotEvidenceReviewRunTaskFn>()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          verdict: 'repair',
          checks: { ...allChecksPass, requested_chain_handled: false },
          violations: ['requested_chain_incomplete'],
          safe_reply: evasiveRepair,
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          verdict: 'reject',
          checks: { ...allChecksPass, requested_chain_handled: false },
          violations: ['requested_chain_incomplete'],
        }),
      });

    const result = await reviewCopilotEvidenceReply(reviewParams({ runTaskFn }));

    expect(result).toEqual({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
    });
    expect(runTaskFn.mock.calls[1]?.[1]).toMatchObject({
      final_reply: evasiveRepair,
      tool_trace: realisticEvidenceTrace,
    });
  });

  it('fails closed when final certification returns invalid non-JSON text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const candidate = '只报告 exact filter 的三行。';
    const runTaskFn = vi
      .fn<CopilotEvidenceReviewRunTaskFn>()
      .mockResolvedValueOnce({
        text: JSON.stringify({ verdict: 'pass', checks: allChecksPass }),
      })
      .mockResolvedValueOnce({ text: '认证通过，但这不是 JSON。' });

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: candidate, runTaskFn }),
    );

    expect(result).toEqual({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
    });
    expect(JSON.stringify(result)).not.toContain(candidate);
  });

  it('preserves source_complete=false when certifying a repair that discloses partial execution', async () => {
    const disclosedRepair = [
      '本轮主任务中途停止；A03 已核到 proposal 的两个直接子事件，二者是 sibling 而非前后因果；其余 review/judge 后段未核验，无法裁决完整链。',
      'A04 已返回的两个 probe_result 顶层 outcome 都为 null、evidence.outcome 都为 0，但存在 redacted 字段，不能裁决唯一差异。',
      'C04 exact action=attempt 的 7 天窗口为 0 行，exact action=review 返回 si6y0w14iihyogdifj7w60c1；queue_assertion.cleared=null，另有 2 条 future_projections，因此无法裁决整个队列是否清空。',
    ].join('\n');
    const runTaskFn = vi
      .fn<CopilotEvidenceReviewRunTaskFn>()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          verdict: 'repair',
          checks: { ...allChecksPass, requested_chain_handled: false },
          violations: ['requested_chain_incomplete'],
          safe_reply: disclosedRepair,
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ verdict: 'certify', checks: allChecksPass }),
      });

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateComplete: false, runTaskFn }),
    );

    expect(result).toMatchObject({ status: 'repair', replyText: disclosedRepair });
    expect(runTaskFn.mock.calls[1]?.[1]).toMatchObject({
      final_reply: disclosedRepair,
      final_text_kind: 'repair',
      source_complete: false,
    });
  });

  it('propagates cancellation between selection and certification without starting round two', async () => {
    const controller = new AbortController();
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => {
      controller.abort(new DOMException('owner stopped', 'AbortError'));
      return {
        text: JSON.stringify({ verdict: 'pass', checks: allChecksPass }),
      };
    });

    await expect(
      reviewCopilotEvidenceReply(reviewParams({ signal: controller.signal, runTaskFn })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('runs the durable-truth gate between selection and paid certification', async () => {
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => ({
      text: JSON.stringify({ verdict: 'pass', checks: allChecksPass }),
    }));
    const beforeVerification = vi.fn(async () => {
      throw new DOMException('owner stopped in durable truth', 'AbortError');
    });

    await expect(
      reviewCopilotEvidenceReply(reviewParams({ runTaskFn, beforeVerification })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(beforeVerification).toHaveBeenCalledTimes(1);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
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

  it('fails closed on an internal task timeout AbortError when the caller signal is still live', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const timedOutRunner = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => {
      throw new DOMException('task budget elapsed', 'AbortError');
    });

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ signal: controller.signal, runTaskFn: timedOutRunner }),
    );

    expect(controller.signal.aborted).toBe(false);
    expect(result).toEqual({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
    });
  });

  it('does not fall back to valid text when native structured output is present but invalid', () => {
    expect(() =>
      parseCopilotEvidenceReviewResult({
        text: JSON.stringify({ verdict: 'pass', checks: allChecksPass }),
        structured_output: { verdict: 'pass', checks: { causality_grounded: true } },
      }),
    ).toThrow();
  });

  it('rejects an all-true certification rejection as internally invalid', () => {
    expect(() =>
      parseCopilotEvidenceVerificationResult({
        text: JSON.stringify({
          verdict: 'reject',
          checks: allChecksPass,
          violations: ['internal_contradiction'],
        }),
      }),
    ).toThrow('must contain at least one failed check');
  });
});
