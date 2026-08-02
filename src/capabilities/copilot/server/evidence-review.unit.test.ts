import {
  CopilotEvidenceReviewOutputSchema,
  CopilotEvidenceVerificationOutputSchema,
} from '@/ai/registry';
import {
  COPILOT_EVIDENCE_COMPARISON_ALLOWED_TOOLS,
  COPILOT_EVIDENCE_REFERENCE_ALLOWED_TOOLS,
  COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME,
} from '@/core/copilot-evidence';
import type { Db } from '@/db/client';
import { AgentRunError } from '@/server/ai/agent-run-error';
import { getReviewDueTool } from '@/server/ai/tools/context-readers';
import { getAttemptContextTool } from '@/server/ai/tools/get-attempt-context';
import { queryKnowledgeTool } from '@/server/ai/tools/knowledge-readers';
import { queryEventsTool } from '@/server/ai/tools/query-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindCopilotEvidenceComparison,
  bindCopilotEvidenceReference,
  safeValidationErrorDetail,
  segmentEvidenceReply,
  segmentEvidenceRequest,
} from './evidence-contract';
import {
  COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS,
  COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS,
  COPILOT_DURABLE_EVIDENCE_REVIEW_TOTAL_TIMEOUT_MS,
  COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS,
  COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS,
  COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
  COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS,
  type CopilotEvidenceReviewRunTaskFn,
  reviewCopilotEvidenceReply,
} from './evidence-review';
import { REALISTIC_EVIDENCE_TRACE } from './evidence-review.actual-fixture';
import type {
  ComparisonEvidenceSubmission,
  CopilotEvidenceSourceCatalogCall,
  ReferenceEvidenceSubmission,
} from './evidence-submission';

const db = {} as Db;
const sourceRef = {
  call_index: 0,
  side: 'output' as const,
  json_pointer: '/events/0/id',
  role: 'value' as const,
};
const gapSourceRef = {
  call_index: 0,
  side: 'output' as const,
  json_pointer: '/claim_boundaries/supports_cross_subject_causal_descendant_claim',
  role: 'scope' as const,
};

const unsafeCandidate = [
  'A01：query_knowledge 返回空，所以三个 KC 从未挂载，且 input evidence_refs → conjecture → rate → probe 是完整因果链。',
  'A03：subjectId 首页 complete_for_window=true，因此产品数据库里从未存在 intervention。',
  'A04：redacted_payload_groups=[] 证明 schema 没有其他字段，B/C 唯一差异就是 activation。',
  'C01：相同 timestamp 与连续 dispatch_seq 证明 review/judge/checkpoint 在同一事务完成。',
  'C04：近 7 天 attempt=0 且页面无卡片，所以整个 queue 已清空。',
].join('\n');

const blindSafeReply = [
  'A01：query_knowledge 的 nodes=[] 只说明当前 active exact domain 没有匹配；supports_never_existed_claim=false。caused_by_event_id 才是因果边，evidence_refs 明示为 supporting_references_noncausal。',
  'A03：probe_result sg6aqgpq6l3wp5maslkvz12j 的直接子事件 ee4x94n2wt1o8sh8z6zxn0yj 是 intervention_activated；但 activation_policy=not_observed，必要/充分条件均 not_supported，所以激活原因无法裁决。',
  'A04：B 的 preparation_failed 投影给出 redacted_payload_groups=[]，C 的 intervention_activated 投影列出 future_diagnostics/private_metadata；两者 payload_projection_exhaustive=false，因此不能据此断言底层无其他字段或两者只有 activation 一项差异。',
  'C01：review si6y0w14iihyogdifj7w60c1 的 judge 与 grading checkpoint 是它的直接子事件；相同 timestamp 和 dispatch_seq 只提供顺序，不证明同一事务。其 FSRS state_after 明示 due=2026-07-31T03:01:12.154Z、stability=2.3065、difficulty=2.11810397。',
  'C04：近 7 天 exact attempt 查询 returned_count=0，due reader 也返回 0 行；但 queue_assertion.cleared=null、completeness=unknown、supports_exhaustive_zero_claim=false，且 delayed/transfer 分别投影到 2026-08-07 与 2026-08-21，因此无法裁决整个 queue 已清空。',
  '操作边界：本轮只依据 13 条只读工具结果，没有执行 propose 或 write。',
].join('\n');

// Mirrors the actual A01 timeout shape: 21 successful read observations and a
// 55KB+ compact trace. The repeated calls model deliberate cross-checks over
// the same typed surfaces rather than padding a tiny toy fixture.
const DURABLE_TIMEOUT_TRACE = [
  ...REALISTIC_EVIDENCE_TRACE,
  ...REALISTIC_EVIDENCE_TRACE.slice(0, 8),
];
const durableTimeoutSafeReply = blindSafeReply.replace('13 条只读工具结果', '21 条只读工具结果');

function evidenceRef(
  callIndex: number,
  jsonPointer: string,
  role: 'value' | 'scope' | 'coverage' | 'relation',
) {
  return {
    call_index: callIndex,
    side: 'output' as const,
    json_pointer: jsonPointer,
    role,
  };
}

function traceCoverageFor(
  points: Array<{
    point_index: number;
    request_unit_indices: number[];
    kind: 'observed_fact' | 'scope_boundary' | 'actual_gap';
    source_refs: Array<{ call_index: number }>;
  }>,
  toolTrace: typeof REALISTIC_EVIDENCE_TRACE,
) {
  return toolTrace.map((observation, callIndex) => {
    const covered = points.filter((point) =>
      point.source_refs.some((ref) => ref.call_index === callIndex),
    );
    const successfulRead =
      observation.effect === 'read' && observation.executed && observation.error_reason === null;
    if (!successfulRead) {
      return {
        call_index: callIndex,
        relevance: 'unusable' as const,
        request_unit_indices: [],
        evidence_point_indices: [],
        rationale_md: '该 observation 不是成功只读结果，不能作为 evidence。',
      };
    }
    if (covered.length === 0) {
      return {
        call_index: callIndex,
        relevance: 'not_material' as const,
        request_unit_indices: [],
        evidence_point_indices: [],
        rationale_md: '该成功只读结果与本次 request atoms 重复或不直接相关。',
      };
    }
    return {
      call_index: callIndex,
      relevance: covered.every((point) => point.kind === 'scope_boundary')
        ? ('scope_only' as const)
        : ('material' as const),
      request_unit_indices: Array.from(
        new Set(covered.flatMap((point) => point.request_unit_indices)),
      ),
      evidence_point_indices: covered.map((point) => point.point_index),
      rationale_md: '该成功只读结果由列出的 request atoms 与 evidence points 显式消费。',
    };
  });
}

function reviewParams(overrides: Partial<Parameters<typeof reviewCopilotEvidenceReply>[0]> = {}) {
  return {
    db,
    requestContext: {
      user_message:
        '按事件 ID 核验 A01/A03/A04 的因果和投影边界；再核验 C01 的 FSRS 链与 C04 queue 是否清零。只读。',
      surface: 'copilot',
      triggered_by: 'chat',
      ambient_context: {
        route: '/admin/runs',
        focused_entity: { kind: 'knowledge', id: 'kc_yuk792_canary_20260731c' },
      },
    },
    candidateReply: unsafeCandidate,
    candidateTaskRunId: 'copilot_task_actual_a01_a03_a04_c01_c04',
    candidateComplete: true,
    toolTrace: REALISTIC_EVIDENCE_TRACE,
    ...overrides,
  };
}

function referenceOutput(input: unknown, options: { gaps?: boolean } = {}) {
  const value = input as {
    request_units: Array<{ index: number }>;
    tool_trace?: typeof REALISTIC_EVIDENCE_TRACE;
  };
  const requestUnits = value.request_units;
  const points = requestUnits.map((unit, index) => ({
    point_index: index,
    request_unit_indices: [unit.index],
    kind: options.gaps ? ('actual_gap' as const) : ('observed_fact' as const),
    statement_md: options.gaps
      ? `请求 ${unit.index} 的确切全局结论未被本轮 typed trace 穷尽。`
      : `请求 ${unit.index} 必须保留 exact typed evidence 与 scope boundary。`,
    source_refs: [options.gaps ? gapSourceRef : sourceRef],
  }));
  return {
    protocol_version: 1 as const,
    evidence_points: points,
    request_coverage: requestUnits.map((unit, index) => ({
      request_unit_index: unit.index,
      status: options.gaps ? ('actual_gap' as const) : ('answerable' as const),
      evidence_point_indices: [index],
    })),
    trace_coverage: traceCoverageFor(points, value.tool_trace ?? REALISTIC_EVIDENCE_TRACE),
    safe_reply: blindSafeReply,
  };
}

function comparisonOutput(input: unknown, options: { fail?: boolean; gaps?: boolean } = {}) {
  const value = input as {
    request_units: Array<{ index: number }>;
    reply_units: Array<{ index: number }>;
    sealed_reference: {
      evidence_points: Array<{ point_index: number }>;
      request_coverage: Array<{ request_unit_index: number; evidence_point_indices: number[] }>;
    };
  };
  const pointCount = value.sealed_reference.evidence_points.length;
  const pointByReply = new Map<number, number[]>();
  for (const point of value.sealed_reference.evidence_points) {
    const replyIndex = point.point_index % value.reply_units.length;
    pointByReply.set(replyIndex, [...(pointByReply.get(replyIndex) ?? []), point.point_index]);
  }
  const replyChecks = value.reply_units.map((unit) => {
    const indices = pointByReply.get(unit.index) ?? [unit.index % pointCount];
    if (options.fail && unit.index === 0) {
      return {
        reply_unit_index: unit.index,
        status: 'unsupported' as const,
        evidence_point_indices: indices,
        source_refs: [],
        reason_codes: ['noncausal_relation' as const],
      };
    }
    return {
      reply_unit_index: unit.index,
      status: options.gaps ? ('explicit_gap' as const) : ('supported' as const),
      evidence_point_indices: indices,
      source_refs: [],
      reason_codes: options.gaps ? (['actual_gap_disclosed'] as const) : (['supported'] as const),
    };
  });
  return {
    protocol_version: 1 as const,
    reply_checks: replyChecks,
    request_checks: value.request_units.map((unit) => {
      const coverage = value.sealed_reference.request_coverage[unit.index];
      const requiredPoints = coverage?.evidence_point_indices ?? [];
      const replyIndices = replyChecks
        .filter((check) =>
          requiredPoints.some((point) => check.evidence_point_indices.includes(point)),
        )
        .map((check) => check.reply_unit_index);
      if (options.fail && unit.index === 0) {
        return {
          request_unit_index: unit.index,
          status: 'missing' as const,
          reply_unit_indices: [],
          evidence_point_indices: [],
          reason_codes: ['requested_chain_incomplete' as const],
        };
      }
      return {
        request_unit_index: unit.index,
        status: options.gaps ? ('explicit_gap' as const) : ('answered' as const),
        reply_unit_indices: replyIndices,
        evidence_point_indices: requiredPoints,
        reason_codes: options.gaps ? (['actual_gap_disclosed'] as const) : (['supported'] as const),
      };
    }),
  };
}

/**
 * Case-specific blind ledger over the real A01/A03/A04/C01/C04 trace. Unlike
 * the mechanical retry fixtures above, every claim binds to the exact typed
 * scalar/empty projection that supports it.
 */
function realisticReferenceOutput(
  input: unknown,
  options: { observationCount?: number; safeReply?: string } = {},
) {
  const value = input as {
    request_units: Array<{ index: number }>;
    tool_trace?: typeof REALISTIC_EVIDENCE_TRACE;
  };
  const requestUnits = value.request_units;
  expect(requestUnits.map((unit) => unit.index)).toEqual([0, 1, 2, 3, 4, 5]);
  const evidencePoints = [
    {
      point_index: 0,
      request_unit_indices: [0],
      kind: 'scope_boundary' as const,
      statement_md:
        'A01 的 active exact-domain lookup 返回空，但 typed boundary 不支持从未存在或全局不存在。',
      source_refs: [
        evidenceRef(1, '/nodes', 'coverage'),
        evidenceRef(1, '/claim_boundaries/supports_never_existed_claim', 'scope'),
        evidenceRef(1, '/claim_boundaries/supports_global_node_absence_claim', 'scope'),
      ],
    },
    {
      point_index: 1,
      request_unit_indices: [0],
      kind: 'observed_fact' as const,
      statement_md: 'A01 的 evidence_refs 是 noncausal supporting references；因果只认 caused_by。',
      source_refs: [
        evidenceRef(2, '/lookup/observed/evidence/evidence_ref_semantics', 'relation'),
        evidenceRef(2, '/lookup/observed/caused_by_event_id', 'relation'),
        evidenceRef(2, '/claim_support/causal_edges', 'relation'),
      ],
    },
    {
      point_index: 2,
      request_unit_indices: [1],
      kind: 'observed_fact' as const,
      statement_md: 'A03 直接观测 probe_result 的 intervention_activated 子事件及其 event id。',
      source_refs: [
        evidenceRef(4, '/causal_neighborhood/direct_children/0/event_id', 'value'),
        evidenceRef(4, '/causal_neighborhood/direct_children/0/action', 'relation'),
      ],
    },
    {
      point_index: 3,
      request_unit_indices: [1],
      kind: 'actual_gap' as const,
      statement_md:
        'A03 的 typed support 不提供 intervention 激活的必要条件、充分条件或观测到的 policy。',
      source_refs: [
        evidenceRef(4, '/claim_support/activation_policy', 'scope'),
        evidenceRef(4, '/claim_support/necessary_conditions', 'scope'),
        evidenceRef(4, '/claim_support/sufficient_conditions', 'scope'),
      ],
    },
    {
      point_index: 4,
      request_unit_indices: [2],
      kind: 'scope_boundary' as const,
      statement_md:
        'A04 的空 redaction list 与非空 redaction list 都来自 non-exhaustive typed projections。',
      source_refs: [
        evidenceRef(
          3,
          '/causal_neighborhood/direct_children/0/redacted_payload_groups',
          'coverage',
        ),
        evidenceRef(
          3,
          '/causal_neighborhood/direct_children/0/payload_projection_exhaustive',
          'scope',
        ),
        evidenceRef(
          4,
          '/causal_neighborhood/direct_children/0/redacted_payload_groups/0',
          'coverage',
        ),
        evidenceRef(
          4,
          '/causal_neighborhood/direct_children/0/payload_projection_exhaustive',
          'scope',
        ),
      ],
    },
    {
      point_index: 5,
      request_unit_indices: [3],
      kind: 'observed_fact' as const,
      statement_md:
        'C01 的 judge 与 grading checkpoint 都是 review 的直接子事件；typed temporal order 明示 noncausal。',
      source_refs: [
        evidenceRef(8, '/lookup/observed/event_id', 'value'),
        evidenceRef(8, '/causal_neighborhood/direct_children/0/event_id', 'relation'),
        evidenceRef(8, '/causal_neighborhood/direct_children/1/event_id', 'relation'),
        evidenceRef(8, '/claim_support/temporal_order', 'scope'),
      ],
    },
    {
      point_index: 6,
      request_unit_indices: [3],
      kind: 'observed_fact' as const,
      statement_md: 'C01 的 review state_after 给出具体 due、stability 与 difficulty。',
      source_refs: [
        evidenceRef(8, '/attempt/fsrs/state_after/due', 'value'),
        evidenceRef(8, '/attempt/fsrs/state_after/stability', 'value'),
        evidenceRef(8, '/attempt/fsrs/state_after/difficulty', 'value'),
      ],
    },
    {
      point_index: 7,
      request_unit_indices: [4],
      kind: 'observed_fact' as const,
      statement_md:
        'C04 的近 7 天 attempt exact filter returned_count=0，且 due reader 返回空 rows；typed scope 不支持 lifecycle inventory claim。',
      source_refs: [
        evidenceRef(10, '/coverage/returned_count', 'value'),
        evidenceRef(10, '/claim_boundaries/zero_rows_scope', 'scope'),
        evidenceRef(10, '/claim_boundaries/supports_lifecycle_status_count_claim', 'scope'),
        evidenceRef(12, '/rows', 'value'),
      ],
    },
    {
      point_index: 8,
      request_unit_indices: [4],
      kind: 'actual_gap' as const,
      statement_md:
        'C04 的 queue cleared 未裁决、coverage unknown 且存在 delayed/transfer future projections。',
      source_refs: [
        evidenceRef(12, '/queue_assertion/cleared', 'scope'),
        evidenceRef(12, '/queue_coverage/completeness', 'coverage'),
        evidenceRef(12, '/queue_coverage/supports_exhaustive_zero_claim', 'scope'),
        evidenceRef(12, '/future_projections/0/due_at', 'value'),
        evidenceRef(12, '/future_projections/1/due_at', 'value'),
      ],
    },
    {
      point_index: 9,
      request_unit_indices: [5],
      kind: 'observed_fact' as const,
      statement_md: `本轮 ${options.observationCount ?? 13} 个观测均来自只读 reader trace；没有 propose/write 结果。`,
      source_refs: [
        evidenceRef(0, '/total', 'value'),
        evidenceRef(5, '/events/0/id', 'value'),
        evidenceRef(12, '/as_of', 'value'),
      ],
    },
  ];
  return {
    protocol_version: 1 as const,
    evidence_points: evidencePoints,
    request_coverage: [
      { request_unit_index: 0, status: 'answerable' as const, evidence_point_indices: [0, 1] },
      { request_unit_index: 1, status: 'actual_gap' as const, evidence_point_indices: [2, 3] },
      { request_unit_index: 2, status: 'answerable' as const, evidence_point_indices: [4] },
      { request_unit_index: 3, status: 'answerable' as const, evidence_point_indices: [5, 6] },
      { request_unit_index: 4, status: 'actual_gap' as const, evidence_point_indices: [7, 8] },
      { request_unit_index: 5, status: 'answerable' as const, evidence_point_indices: [9] },
    ],
    trace_coverage: traceCoverageFor(evidencePoints, value.tool_trace ?? REALISTIC_EVIDENCE_TRACE),
    safe_reply: options.safeReply ?? blindSafeReply,
  };
}

function realisticComparisonOutput(input: unknown, options: { unsafe: boolean }) {
  const value = input as {
    request_units: Array<{ index: number }>;
    reply_units: Array<{ index: number }>;
  };
  expect(value.request_units.map((unit) => unit.index)).toEqual([0, 1, 2, 3, 4, 5]);
  if (options.unsafe) {
    expect(value.reply_units.map((unit) => unit.index)).toEqual([0, 1, 2, 3, 4]);
    return {
      protocol_version: 1 as const,
      reply_checks: [
        {
          reply_unit_index: 0,
          status: 'unsupported' as const,
          evidence_point_indices: [0, 1],
          source_refs: [],
          reason_codes: ['noncausal_relation' as const],
        },
        {
          reply_unit_index: 1,
          status: 'unsupported' as const,
          evidence_point_indices: [2, 3],
          source_refs: [],
          reason_codes: ['incomplete_scope_or_pagination' as const],
        },
        {
          reply_unit_index: 2,
          status: 'unsupported' as const,
          evidence_point_indices: [4],
          source_refs: [],
          reason_codes: ['projection_boundary_crossed' as const],
        },
        {
          reply_unit_index: 3,
          status: 'unsupported' as const,
          evidence_point_indices: [5, 6],
          source_refs: [],
          reason_codes: ['internal_contradiction' as const],
        },
        {
          reply_unit_index: 4,
          status: 'unsupported' as const,
          evidence_point_indices: [7, 8],
          source_refs: [],
          reason_codes: ['queue_or_count_unknown_promoted' as const],
        },
      ],
      request_checks: [
        {
          request_unit_index: 0,
          status: 'answered' as const,
          reply_unit_indices: [0],
          evidence_point_indices: [0, 1],
          reason_codes: ['supported' as const],
        },
        {
          request_unit_index: 1,
          status: 'answered' as const,
          reply_unit_indices: [1],
          evidence_point_indices: [2, 3],
          reason_codes: ['supported' as const],
        },
        {
          request_unit_index: 2,
          status: 'answered' as const,
          reply_unit_indices: [2],
          evidence_point_indices: [4],
          reason_codes: ['supported' as const],
        },
        {
          request_unit_index: 3,
          status: 'answered' as const,
          reply_unit_indices: [3],
          evidence_point_indices: [5, 6],
          reason_codes: ['supported' as const],
        },
        {
          request_unit_index: 4,
          status: 'answered' as const,
          reply_unit_indices: [4],
          evidence_point_indices: [7, 8],
          reason_codes: ['supported' as const],
        },
        {
          request_unit_index: 5,
          status: 'missing' as const,
          reply_unit_indices: [],
          evidence_point_indices: [9],
          reason_codes: ['requested_chain_incomplete' as const],
        },
      ],
    };
  }

  expect(value.reply_units.map((unit) => unit.index)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ]);
  return {
    protocol_version: 1 as const,
    reply_checks: [
      {
        reply_unit_index: 0,
        status: 'supported' as const,
        evidence_point_indices: [0],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 1,
        status: 'supported' as const,
        evidence_point_indices: [0],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 2,
        status: 'supported' as const,
        evidence_point_indices: [1],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 3,
        status: 'supported' as const,
        evidence_point_indices: [2],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 4,
        status: 'explicit_gap' as const,
        evidence_point_indices: [3],
        source_refs: [],
        reason_codes: ['actual_gap_disclosed' as const],
      },
      {
        reply_unit_index: 5,
        status: 'supported' as const,
        evidence_point_indices: [4],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 6,
        status: 'supported' as const,
        evidence_point_indices: [4],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 7,
        status: 'supported' as const,
        evidence_point_indices: [5],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 8,
        status: 'supported' as const,
        evidence_point_indices: [5],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 9,
        status: 'supported' as const,
        evidence_point_indices: [6],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 10,
        status: 'supported' as const,
        evidence_point_indices: [7],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
      {
        reply_unit_index: 11,
        status: 'explicit_gap' as const,
        evidence_point_indices: [8],
        source_refs: [],
        reason_codes: ['actual_gap_disclosed' as const],
      },
      {
        reply_unit_index: 12,
        status: 'supported' as const,
        evidence_point_indices: [9],
        source_refs: [],
        reason_codes: ['supported' as const],
      },
    ],
    request_checks: [
      {
        request_unit_index: 0,
        status: 'answered' as const,
        reply_unit_indices: [0, 1, 2],
        evidence_point_indices: [0, 1],
        reason_codes: ['supported' as const],
      },
      {
        request_unit_index: 1,
        status: 'explicit_gap' as const,
        reply_unit_indices: [3, 4],
        evidence_point_indices: [2, 3],
        reason_codes: ['actual_gap_disclosed' as const],
      },
      {
        request_unit_index: 2,
        status: 'answered' as const,
        reply_unit_indices: [5, 6],
        evidence_point_indices: [4],
        reason_codes: ['supported' as const],
      },
      {
        request_unit_index: 3,
        status: 'answered' as const,
        reply_unit_indices: [7, 8, 9],
        evidence_point_indices: [5, 6],
        reason_codes: ['supported' as const],
      },
      {
        request_unit_index: 4,
        status: 'explicit_gap' as const,
        reply_unit_indices: [10, 11],
        evidence_point_indices: [7, 8],
        reason_codes: ['actual_gap_disclosed' as const],
      },
      {
        request_unit_index: 5,
        status: 'answered' as const,
        reply_unit_indices: [12],
        evidence_point_indices: [9],
        reason_codes: ['supported' as const],
      },
    ],
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function submitReferenceOutput(
  input: unknown,
  submission: ReferenceEvidenceSubmission | undefined,
  output: unknown,
): void {
  if (!submission) throw new Error('reference submission seam missing');
  const parsed = CopilotEvidenceReviewOutputSchema.safeParse(output);
  if (!parsed.success) return;
  const sourceCatalog = (input as { source_catalog: CopilotEvidenceSourceCatalogCall[] })
    .source_catalog;
  const sourceIdByRef = new Map(
    sourceCatalog.flatMap((call) =>
      (['input', 'output'] as const).flatMap((side) =>
        call[side].map(
          ([sourceId, jsonPointer]) =>
            [`${call.call_index}:${side}:${jsonPointer}`, sourceId] as const,
        ),
      ),
    ),
  );
  const points = parsed.data.evidence_points.map((point) => ({
    request_unit_indices: point.request_unit_indices,
    kind: point.kind,
    statement_md: point.statement_md,
    sources: point.source_refs.map((source) => ({
      source_id:
        sourceIdByRef.get(`${source.call_index}:${source.side}:${source.json_pointer}`) ??
        's999999',
      role: source.role,
    })),
  }));
  for (const pointsChunk of chunk(points, 12)) {
    submission.appendEvidencePoints({ points: pointsChunk });
  }
  const notMaterial = parsed.data.trace_coverage.flatMap((coverage) =>
    coverage.relevance === 'not_material'
      ? [{ call_index: coverage.call_index, rationale_md: coverage.rationale_md }]
      : [],
  );
  for (const calls of chunk(notMaterial, 12)) {
    submission.markTraceCallsNotMaterial({ calls });
  }
  submission.setSafeReply({ safe_reply: parsed.data.safe_reply });
  submission.completeReference();
}

function submitComparisonOutput(
  input: unknown,
  submission: ComparisonEvidenceSubmission | undefined,
  output: unknown,
): void {
  if (!submission) throw new Error('comparison submission seam missing');
  const parsed = CopilotEvidenceVerificationOutputSchema.safeParse(output);
  if (!parsed.success) return;
  const sealedCoverage = (
    input as {
      sealed_reference: {
        request_coverage: Array<{
          request_unit_index: number;
          evidence_point_indices: number[];
        }>;
      };
    }
  ).sealed_reference.request_coverage;
  const checks = parsed.data.reply_checks.map((check) => ({
    reply_unit_index: check.reply_unit_index,
    request_unit_indices:
      check.reason_codes.length === 1 && check.reason_codes[0] === 'non_evidentiary'
        ? []
        : sealedCoverage
            .filter((coverage) =>
              coverage.evidence_point_indices.some((point) =>
                check.evidence_point_indices.includes(point),
              ),
            )
            .map((coverage) => coverage.request_unit_index),
    status: check.status,
    evidence_point_indices: check.evidence_point_indices,
    reason_codes: check.reason_codes,
  }));
  for (const checksChunk of chunk(checks, 12)) {
    submission.appendReplyChecks({ checks: checksChunk });
  }
  submission.completeComparison();
}

function submitTaskOutput(
  kind: 'CopilotEvidenceReviewTask' | 'CopilotEvidenceVerificationTask',
  input: unknown,
  submission: ReferenceEvidenceSubmission | ComparisonEvidenceSubmission | undefined,
  output: unknown,
  taskRunId: string,
) {
  if (kind === 'CopilotEvidenceReviewTask') {
    submitReferenceOutput(input, submission as ReferenceEvidenceSubmission | undefined, output);
  } else {
    submitComparisonOutput(input, submission as ComparisonEvidenceSubmission | undefined, output);
  }
  return { task_run_id: taskRunId, text: '' };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Copilot FULL evidence review', () => {
  it('uses actual-proven durable tails while keeping the inline validator budget unchanged', async () => {
    let comparisonOrdinal = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          return submitTaskOutput(
            kind,
            input,
            submission,
            realisticReferenceOutput(input, {
              observationCount: DURABLE_TIMEOUT_TRACE.length,
              safeReply: durableTimeoutSafeReply,
            }),
            'durable-reference',
          );
        }
        comparisonOrdinal += 1;
        return submitTaskOutput(
          kind,
          input,
          submission,
          realisticComparisonOutput(input, { unsafe: false }),
          `durable-comparison-${comparisonOrdinal}`,
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(
      reviewParams({
        candidateReply: durableTimeoutSafeReply,
        toolTrace: DURABLE_TIMEOUT_TRACE,
        attemptTimeouts: {
          referenceMs: COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS,
          comparisonMs: COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS,
        },
        runTaskFn,
      }),
    );

    expect(DURABLE_TIMEOUT_TRACE).toHaveLength(21);
    expect(JSON.stringify(DURABLE_TIMEOUT_TRACE).length).toBeGreaterThan(55_000);
    expect(result.status).toBe('pass');
    expect(runTaskFn.mock.calls[0]?.[2].budgetOverride).toEqual({
      timeoutMs: COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS,
    });
    expect(runTaskFn.mock.calls[0]?.[2]).toMatchObject({
      allowedTools: [...COPILOT_EVIDENCE_REFERENCE_ALLOWED_TOOLS],
      autoLogToolCalls: false,
      mcpServers: { [COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME]: expect.any(Object) },
    });
    expect(runTaskFn.mock.calls[0]?.[2]).not.toHaveProperty('outputFormat');
    expect(runTaskFn.mock.calls[0]?.[1]).toMatchObject({
      submission_protocol: {
        kind: 'append_only_tools',
        server_derives: expect.arrayContaining(['json_pointers', 'request_coverage']),
      },
      source_catalog: expect.arrayContaining([
        expect.objectContaining({
          call_index: 0,
          input: expect.arrayContaining([['s0', expect.stringMatching(/^\//)]]),
        }),
      ]),
    });
    expect(JSON.stringify(runTaskFn.mock.calls[0]?.[1]).length).toBeLessThan(200_000);
    expect(runTaskFn.mock.calls[1]?.[2].budgetOverride).toEqual({
      timeoutMs: COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS,
    });
    expect(runTaskFn.mock.calls[2]?.[2].budgetOverride).toEqual({
      timeoutMs: COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS,
    });
    expect(runTaskFn.mock.calls[1]?.[2]).toMatchObject({
      allowedTools: [...COPILOT_EVIDENCE_COMPARISON_ALLOWED_TOOLS],
      autoLogToolCalls: false,
    });
    expect(runTaskFn.mock.calls[1]?.[2]).not.toHaveProperty('outputFormat');
    expect(COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS).toBe(360_000);
    expect(COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS).toBe(360_000);
    expect(COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS).toBe(120_000);
    expect(COPILOT_DURABLE_EVIDENCE_REVIEW_TOTAL_TIMEOUT_MS).toBe(
      COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS * COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS +
        COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS *
          COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS *
          2,
    );
  });

  it('keeps fixed parser and binder diagnostics single-line and bounded without exposing unknown errors', () => {
    expect(
      safeValidationErrorDetail(
        new Error('copilot blind evidence reference output did not contain a JSON object'),
      ),
    ).toBe('Error:copilot blind evidence reference output did not contain a JSON object');
    expect(safeValidationErrorDetail(new Error('trace coverage\nbackref mismatch'))).toBe(
      'Error:trace coverage backref mismatch',
    );
    expect(safeValidationErrorDetail(new Error(`bounded ${'x'.repeat(400)}`))).toHaveLength(240);
    expect(safeValidationErrorDetail(new SyntaxError('do not expose parser details'))).toBe(
      'SyntaxError:output JSON syntax invalid',
    );
    expect(safeValidationErrorDetail(new TypeError('do not expose this detail'))).toBe('TypeError');
  });

  it('keeps the 13-observation, 30KB+ realistic tool trace valid against every reader schema', () => {
    expect(REALISTIC_EVIDENCE_TRACE).toHaveLength(13);
    expect(JSON.stringify(REALISTIC_EVIDENCE_TRACE).length).toBeGreaterThan(30_000);
    for (const observation of REALISTIC_EVIDENCE_TRACE) {
      if (observation.name === 'query_events') {
        expect(queryEventsTool.outputSchema.safeParse(observation.output).success).toBe(true);
      }
      if (observation.name === 'query_knowledge') {
        expect(queryKnowledgeTool.outputSchema.safeParse(observation.output).success).toBe(true);
      }
      if (observation.name === 'get_attempt_context') {
        expect(getAttemptContextTool.outputSchema.safeParse(observation.output).success).toBe(true);
      }
      if (observation.name === 'get_review_due') {
        expect(getReviewDueTool.outputSchema.safeParse(observation.output).success).toBe(true);
      }
    }
  });

  it('skips paid validation when no successful DomainTool read was observed', async () => {
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>();
    const result = await reviewCopilotEvidenceReply(
      reviewParams({
        candidateReply: '我可以帮你把问题收窄。',
        toolTrace: [
          {
            name: 'propose_knowledge_edge',
            effect: 'propose',
            input: { from_id: 'kc_a', to_id: 'kc_b' },
            output: { proposal_id: 'proposal_01' },
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

  it('preserves original bytes only after blind reference plus two bound passes', async () => {
    const candidate = blindSafeReply;
    let comparisonOrdinal = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          return submitTaskOutput(
            kind,
            input,
            submission,
            realisticReferenceOutput(input),
            'reference-1',
          );
        }
        comparisonOrdinal += 1;
        return submitTaskOutput(
          kind,
          input,
          submission,
          realisticComparisonOutput(input, { unsafe: false }),
          `comparison-${comparisonOrdinal}`,
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: candidate, runTaskFn }),
    );

    expect(result).toMatchObject({
      status: 'pass',
      replyText: candidate,
      reviewTaskRunId: 'reference-1',
      verificationTaskRunId: 'comparison-2',
      referenceTaskRunIds: ['reference-1'],
      comparisonTaskRunIds: ['comparison-1', 'comparison-2'],
    });
    expect(runTaskFn).toHaveBeenCalledTimes(3);
    expect(runTaskFn.mock.calls[0]?.[1]).not.toHaveProperty('candidate_reply');
    expect(runTaskFn.mock.calls[0]?.[1]).not.toHaveProperty('final_reply');
    expect(runTaskFn.mock.calls[1]?.[1]).toMatchObject({
      selected_text_kind: 'original',
      tool_trace: REALISTIC_EVIDENCE_TRACE,
    });
    expect(runTaskFn.mock.calls[1]?.[1]).toEqual(runTaskFn.mock.calls[2]?.[1]);
  });

  it('rejects the complex unsafe original and exposes the blind reply only after two fresh passes', async () => {
    let comparisonOrdinal = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          return submitTaskOutput(
            kind,
            input,
            submission,
            realisticReferenceOutput(input),
            'reference-realistic',
          );
        }
        const selectedKind = (input as { selected_text_kind: string }).selected_text_kind;
        comparisonOrdinal += 1;
        return submitTaskOutput(
          kind,
          input,
          submission,
          realisticComparisonOutput(input, {
            unsafe: selectedKind === 'original',
          }),
          `comparison-${comparisonOrdinal}`,
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(reviewParams({ runTaskFn }));

    expect(result).toMatchObject({
      status: 'repair',
      replyText: blindSafeReply,
      violations: [
        'noncausal_relation',
        'incomplete_scope_or_pagination',
        'projection_boundary_crossed',
        'internal_contradiction',
        'queue_or_count_unknown_promoted',
        'requested_chain_incomplete',
      ],
      referenceTaskRunIds: ['reference-realistic'],
      comparisonTaskRunIds: ['comparison-1', 'comparison-2', 'comparison-3'],
      verificationTaskRunId: 'comparison-3',
    });
    expect(runTaskFn).toHaveBeenCalledTimes(4);
    expect(runTaskFn.mock.calls[2]?.[1]).toEqual(runTaskFn.mock.calls[3]?.[1]);
    expect(JSON.stringify(runTaskFn.mock.calls[0]?.[1])).not.toContain(unsafeCandidate);
  });

  it('retries a contract-invalid blind ledger with bounded server feedback only', async () => {
    let referenceAttempt = 0;
    let comparisonOrdinal = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          referenceAttempt += 1;
          if (referenceAttempt === 1) {
            return { task_run_id: 'reference-invalid', text: '' };
          }
          return submitTaskOutput(
            kind,
            input,
            submission,
            referenceOutput(input),
            'reference-valid',
          );
        }
        comparisonOrdinal += 1;
        return submitTaskOutput(
          kind,
          input,
          submission,
          comparisonOutput(input),
          `comparison-valid-${comparisonOrdinal}`,
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: blindSafeReply, runTaskFn }),
    );

    expect(result.status).toBe('pass');
    const firstInput = runTaskFn.mock.calls[0]?.[1] as Record<string, unknown>;
    const secondInput = runTaskFn.mock.calls[1]?.[1] as Record<string, unknown>;
    const { contract_feedback: feedback, ...secondBase } = secondInput;
    expect(secondBase).toEqual(firstInput);
    expect(feedback).toEqual({
      previous_attempt: 1,
      rejection: 'evidence_points_missing',
    });
    expect(JSON.stringify(feedback)).not.toContain(unsafeCandidate);
    expect(result.referenceTaskRunIds).toEqual(['reference-invalid', 'reference-valid']);
  });

  it('feeds an unknown short source id rejection into the second blind attempt', async () => {
    let referenceAttempt = 0;
    let comparisonAttempt = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          referenceAttempt += 1;
          const output = realisticReferenceOutput(input);
          if (referenceAttempt === 1) {
            const sourceRef = output.evidence_points[2]?.source_refs[0];
            if (!sourceRef) throw new Error('realistic fixture is missing its third source ref');
            sourceRef.json_pointer = '/path/not/in/server/source/catalog';
          }
          return submitTaskOutput(
            kind,
            input,
            submission,
            output,
            `reference-source-id-${referenceAttempt}`,
          );
        }
        comparisonAttempt += 1;
        return submitTaskOutput(
          kind,
          input,
          submission,
          realisticComparisonOutput(input, { unsafe: false }),
          `comparison-after-source-id-${comparisonAttempt}`,
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: blindSafeReply, runTaskFn }),
    );

    expect(result.status).toBe('pass');
    expect(runTaskFn.mock.calls[1]?.[1]).toMatchObject({
      contract_feedback: {
        previous_attempt: 1,
        rejection: 'evidence_points_missing',
      },
    });
    expect(result.referenceTaskRunIds).toEqual(['reference-source-id-1', 'reference-source-id-2']);
  });

  it('keeps a failed paid blind-reference run id when the next attempt succeeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let referenceAttempt = 0;
    let comparisonAttempt = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          referenceAttempt += 1;
          if (referenceAttempt === 1) {
            throw new AgentRunError({
              kind,
              taskRunId: 'reference-provider-failed',
              subtype: 'api_error_result',
              apiErrorStatus: 503,
              errors: ['upstream unavailable'],
            });
          }
          return submitTaskOutput(
            kind,
            input,
            submission,
            referenceOutput(input),
            'reference-provider-recovered',
          );
        }
        comparisonAttempt += 1;
        return submitTaskOutput(
          kind,
          input,
          submission,
          comparisonOutput(input),
          `comparison-after-reference-recovery-${comparisonAttempt}`,
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: blindSafeReply, runTaskFn }),
    );

    expect(result).toMatchObject({
      status: 'pass',
      referenceTaskRunIds: ['reference-provider-failed', 'reference-provider-recovered'],
      comparisonTaskRunIds: [
        'comparison-after-reference-recovery-1',
        'comparison-after-reference-recovery-2',
      ],
    });
    expect(warnSpy).toHaveBeenCalledWith('[copilot-evidence-review] blind reference task failed', {
      attempt: 1,
      failure_kind: 'api_error_result',
      progress: {
        evidence_point_count: 0,
        not_material_call_count: 0,
        safe_reply_set: false,
        completed: false,
      },
    });
  });

  it('does not let one valid pass wash away a contract-invalid comparator attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let comparatorAttempt = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          return submitTaskOutput(kind, input, submission, referenceOutput(input), 'reference');
        }
        comparatorAttempt += 1;
        if (comparatorAttempt === 1) {
          return { task_run_id: 'comparison-invalid', text: '' };
        }
        return submitTaskOutput(
          kind,
          input,
          submission,
          comparisonOutput(input),
          'comparison-pass',
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: blindSafeReply, runTaskFn }),
    );

    expect(result).toMatchObject({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
      referenceTaskRunIds: ['reference'],
      comparisonTaskRunIds: ['comparison-invalid', 'comparison-pass'],
    });
    expect(runTaskFn.mock.calls[2]?.[1]).toMatchObject({
      contract_feedback: {
        previous_attempt: 1,
        rejection: 'reply_checks_incomplete',
      },
    });
  });

  it('keeps a failed paid comparator id when a later pass cannot confirm it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let comparatorAttempt = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          return submitTaskOutput(kind, input, submission, referenceOutput(input), 'reference');
        }
        comparatorAttempt += 1;
        if (comparatorAttempt === 1) {
          throw new AgentRunError({
            kind,
            taskRunId: 'comparison-provider-failed',
            subtype: 'stream_no_terminal',
            errors: ['stream ended without terminal'],
          });
        }
        return submitTaskOutput(
          kind,
          input,
          submission,
          comparisonOutput(input),
          'comparison-provider-recovered',
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: blindSafeReply, runTaskFn }),
    );

    expect(result).toMatchObject({
      status: 'failed_closed',
      referenceTaskRunIds: ['reference'],
      comparisonTaskRunIds: ['comparison-provider-failed', 'comparison-provider-recovered'],
    });
    expect(warnSpy).toHaveBeenCalledWith('[copilot-evidence-review] comparator task failed', {
      attempt: 1,
      failure_kind: 'stream_no_terminal',
      progress: {
        reply_check_count: 0,
        completed: false,
      },
    });
  });

  it('fails closed when the blind fallback itself is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let comparisonOrdinal = 0;
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          return submitTaskOutput(kind, input, submission, referenceOutput(input), 'reference');
        }
        comparisonOrdinal += 1;
        return submitTaskOutput(
          kind,
          input,
          submission,
          comparisonOutput(input, { fail: true }),
          `comparison-${comparisonOrdinal}`,
        );
      },
    );

    const result = await reviewCopilotEvidenceReply(reviewParams({ runTaskFn }));

    expect(result.replyText).toBe(COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY);
    expect(JSON.stringify(result)).not.toContain(blindSafeReply);
  });

  it('propagates cancellation between paid calls', async () => {
    const controller = new AbortController();
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        controller.abort(new DOMException('owner stopped', 'AbortError'));
        return submitTaskOutput(
          kind,
          input,
          submission,
          referenceOutput(input),
          'reference-before-stop',
        );
      },
    );

    await expect(
      reviewCopilotEvidenceReply(
        reviewParams({ signal: controller.signal, runTaskFn, candidateReply: blindSafeReply }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('runs durable truth before every paid validation call', async () => {
    const beforeVerification = vi.fn(async () => {
      throw new DOMException('owner stopped in durable truth', 'AbortError');
    });
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>();

    await expect(
      reviewCopilotEvidenceReply(
        reviewParams({ beforeVerification, runTaskFn, candidateReply: blindSafeReply }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(beforeVerification).toHaveBeenCalledTimes(1);
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('treats provider AbortError as a paid failure unless the caller signal is aborted', async () => {
    const liveSignal = new AbortController().signal;
    const referenceRunTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => {
      throw new DOMException('provider task budget elapsed', 'AbortError');
    });

    const referenceResult = await reviewCopilotEvidenceReply(
      reviewParams({ signal: liveSignal, runTaskFn: referenceRunTaskFn }),
    );
    expect(referenceResult).toMatchObject({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
      referenceTaskRunIds: [],
    });
    expect(referenceRunTaskFn).toHaveBeenCalledTimes(2);

    const comparisonRunTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        if (kind === 'CopilotEvidenceReviewTask') {
          return submitTaskOutput(kind, input, submission, referenceOutput(input), 'reference');
        }
        throw new DOMException('sdk stream budget elapsed', 'AbortError');
      },
    );
    const comparisonResult = await reviewCopilotEvidenceReply(
      reviewParams({ runTaskFn: comparisonRunTaskFn, candidateReply: blindSafeReply }),
    );
    expect(comparisonResult).toMatchObject({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
      referenceTaskRunIds: ['reference'],
      comparisonTaskRunIds: [],
    });
    expect(comparisonRunTaskFn).toHaveBeenCalledTimes(3);
  });

  it('fails closed on oversized or structurally empty replies without leaking prose', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>();
    const oversized = await reviewCopilotEvidenceReply(
      reviewParams({ candidateReply: 'x'.repeat(64_001), runTaskFn }),
    );

    expect(oversized.replyText).toBe(COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY);
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('fails closed before a paid call when a reader observation is not canonical JSON data', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>();
    const result = await reviewCopilotEvidenceReply(
      reviewParams({
        candidateReply: 'exact_event_01 存在。',
        toolTrace: [
          {
            name: 'query_events',
            effect: 'read',
            input: { filter: { eventId: 'exact_event_01' } },
            output: { event_id: undefined },
            error_reason: null,
            executed: true,
          },
        ],
        runTaskFn,
      }),
    );

    expect(result).toMatchObject({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
    });
    expect(runTaskFn).not.toHaveBeenCalled();
  });
});

describe('sealed evidence contract', () => {
  it('atomizes five labeled request subparts instead of letting one dense row hide four omissions', () => {
    const units = segmentEvidenceRequest({
      user_message: '请分别核验 A01、A03、A04、C01、C04。',
    });
    expect(units.map((unit) => unit.text)).toEqual([
      '请分别核验 A01、',
      'A03、',
      'A04、',
      'C01、',
      'C04。',
    ]);
  });

  it('atomizes ordinary comma, 顿号, numbered, and Markdown-list requests without issue labels', () => {
    expect(
      segmentEvidenceRequest({ user_message: '请分别核验姓名、时间、状态、原因。' }).map(
        (unit) => unit.text,
      ),
    ).toEqual(['请分别核验姓名、', '时间、', '状态、', '原因。']);
    expect(
      segmentEvidenceRequest({ user_message: 'Check 1) name, 2) time, 3) status.' }).map(
        (unit) => unit.text,
      ),
    ).toEqual(['Check 1) name,', '2) time,', '3) status.']);
    expect(
      segmentEvidenceRequest({ user_message: '- 核验姓名\n- 核验时间\n- 核验状态' }).map(
        (unit) => unit.text,
      ),
    ).toEqual(['- 核验姓名', '- 核验时间', '- 核验状态']);
  });

  it('can seal the 60th durable read and rejects a ledger that omits the final trace call', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验 LAST59。' });
    const toolTrace = Array.from({ length: 60 }, (_, index) => ({
      name: 'query_events',
      effect: 'read' as const,
      input: { index },
      output: { value: `event_${index}` },
      error_reason: null,
      executed: true,
    }));
    const value = {
      protocol_version: 1 as const,
      evidence_points: [
        {
          point_index: 0,
          request_unit_indices: [0],
          kind: 'observed_fact' as const,
          statement_md: '第 60 次 read 返回 event_59。',
          source_refs: [evidenceRef(59, '/value', 'value')],
        },
      ],
      request_coverage: [
        { request_unit_index: 0, status: 'answerable' as const, evidence_point_indices: [0] },
      ],
      trace_coverage: toolTrace.map((_observation, callIndex) => ({
        call_index: callIndex,
        relevance: callIndex === 59 ? ('material' as const) : ('not_material' as const),
        request_unit_indices: callIndex === 59 ? [0] : [],
        evidence_point_indices: callIndex === 59 ? [0] : [],
        rationale_md:
          callIndex === 59 ? '最后一次 read 直接回答请求。' : '此前 read 与 LAST59 不直接相关。',
      })),
      safe_reply: '第 60 次 read 返回 event_59。',
    };

    expect(
      bindCopilotEvidenceReference({ value, requestUnits, toolTrace }).output.trace_coverage,
    ).toHaveLength(60);
    expect(() =>
      bindCopilotEvidenceReference({
        value: { ...value, trace_coverage: value.trace_coverage.slice(0, 59) },
        requestUnits,
        toolTrace,
      }),
    ).toThrow('trace_coverage');
  });

  it('derives fail when an actual gap is mislabeled as supported/answered', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验缺失范围。' });
    const toolTrace = [
      {
        name: 'query_events',
        effect: 'read' as const,
        input: { limit: 20 },
        output: { completeness: null },
        error_reason: null,
        executed: true,
      },
    ];
    const reference = bindCopilotEvidenceReference({
      value: {
        protocol_version: 1,
        evidence_points: [
          {
            point_index: 0,
            request_unit_indices: [0],
            kind: 'actual_gap',
            statement_md: '完整性未被观测。',
            source_refs: [evidenceRef(0, '/completeness', 'scope')],
          },
        ],
        request_coverage: [
          { request_unit_index: 0, status: 'actual_gap', evidence_point_indices: [0] },
        ],
        trace_coverage: [
          {
            call_index: 0,
            relevance: 'material',
            request_unit_indices: [0],
            evidence_point_indices: [0],
            rationale_md: 'null completeness 是请求的承重缺口。',
          },
        ],
        safe_reply: '完整性未被观测，因此无法裁决。',
      },
      requestUnits,
      toolTrace,
    });
    const replyUnits = segmentEvidenceReply('完整性已经确认。');
    const result = bindCopilotEvidenceComparison({
      value: {
        protocol_version: 1,
        reply_checks: [
          {
            reply_unit_index: 0,
            status: 'supported',
            evidence_point_indices: [0],
            source_refs: [],
            reason_codes: ['supported'],
          },
        ],
        request_checks: [
          {
            request_unit_index: 0,
            status: 'answered',
            reply_unit_indices: [0],
            evidence_point_indices: [0],
            reason_codes: ['supported'],
          },
        ],
      },
      requestUnits,
      replyUnits,
      selectedReplySha256: 'e'.repeat(64),
      reference,
      toolTrace,
      sourceComplete: true,
    });

    expect(result).toMatchObject({
      verdict: 'fail',
      violations: ['requested_chain_incomplete'],
    });
  });

  it('rejects an actual-gap request that binds only a scope boundary and can never be certified', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验完整队列。' });
    const toolTrace = [
      {
        name: 'get_review_due',
        effect: 'read' as const,
        input: { limit: 100 },
        output: { completeness: 'exact_filter_only' },
        error_reason: null,
        executed: true,
      },
    ];

    expect(() =>
      bindCopilotEvidenceReference({
        value: {
          protocol_version: 1,
          evidence_points: [
            {
              point_index: 0,
              request_unit_indices: [0],
              kind: 'scope_boundary',
              statement_md: '读取只覆盖 exact filter。',
              source_refs: [evidenceRef(0, '/completeness', 'scope')],
            },
          ],
          request_coverage: [
            { request_unit_index: 0, status: 'actual_gap', evidence_point_indices: [0] },
          ],
          trace_coverage: [
            {
              call_index: 0,
              relevance: 'scope_only',
              request_unit_indices: [0],
              evidence_point_indices: [0],
              rationale_md: '该读取只提供 scope。',
            },
          ],
          safe_reply: '当前只知道读取范围。',
        },
        requestUnits,
        toolTrace,
      }),
    ).toThrow('actual-gap');
  });

  it('does not let answerable facts or failure reason codes masquerade as a valid gap', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验 exact scope。' });
    const toolTrace = [
      {
        name: 'query_events',
        effect: 'read' as const,
        input: { limit: 20 },
        output: { scope: 'exact_filter_only' },
        error_reason: null,
        executed: true,
      },
    ];
    const reference = bindCopilotEvidenceReference({
      value: {
        protocol_version: 1,
        evidence_points: [
          {
            point_index: 0,
            request_unit_indices: [0],
            kind: 'scope_boundary',
            statement_md: '当前 scope 是 exact_filter_only。',
            source_refs: [evidenceRef(0, '/scope', 'scope')],
          },
        ],
        request_coverage: [
          { request_unit_index: 0, status: 'answerable', evidence_point_indices: [0] },
        ],
        trace_coverage: [
          {
            call_index: 0,
            relevance: 'scope_only',
            request_unit_indices: [0],
            evidence_point_indices: [0],
            rationale_md: '该 scope 直接限定请求。',
          },
        ],
        safe_reply: '当前 scope 是 exact_filter_only。',
      },
      requestUnits,
      toolTrace,
    });
    const replyUnits = segmentEvidenceReply('当前 scope 无法裁决。');
    const result = bindCopilotEvidenceComparison({
      value: {
        protocol_version: 1,
        reply_checks: [
          {
            reply_unit_index: 0,
            status: 'explicit_gap',
            evidence_point_indices: [0],
            source_refs: [],
            reason_codes: ['actual_gap_disclosed'],
          },
        ],
        request_checks: [
          {
            request_unit_index: 0,
            status: 'explicit_gap',
            reply_unit_indices: [0],
            evidence_point_indices: [0],
            reason_codes: ['actual_gap_disclosed', 'internal_contradiction'],
          },
        ],
      },
      requestUnits,
      replyUnits,
      selectedReplySha256: 'f'.repeat(64),
      reference,
      toolTrace,
      sourceComplete: true,
    });

    expect(result.verdict).toBe('fail');
    expect(result.violations).toEqual(
      expect.arrayContaining(['requested_chain_incomplete', 'internal_contradiction']),
    );

    const answeredThroughGap = bindCopilotEvidenceComparison({
      value: {
        protocol_version: 1,
        reply_checks: [
          {
            reply_unit_index: 0,
            status: 'explicit_gap',
            evidence_point_indices: [0],
            source_refs: [],
            reason_codes: ['actual_gap_disclosed'],
          },
        ],
        request_checks: [
          {
            request_unit_index: 0,
            status: 'answered',
            reply_unit_indices: [0],
            evidence_point_indices: [0],
            reason_codes: ['supported'],
          },
        ],
      },
      requestUnits,
      replyUnits,
      selectedReplySha256: '1'.repeat(64),
      reference,
      toolTrace,
      sourceComplete: true,
    });
    expect(answeredThroughGap).toMatchObject({
      verdict: 'fail',
      violations: ['requested_chain_incomplete'],
    });
  });

  it('does not let a Markdown separator stand in for a material answer', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验 event id。' });
    const toolTrace = [
      {
        name: 'query_events',
        effect: 'read' as const,
        input: { limit: 1 },
        output: { event_id: 'evt_real_01' },
        error_reason: null,
        executed: true,
      },
    ];
    const reference = bindCopilotEvidenceReference({
      value: {
        protocol_version: 1,
        evidence_points: [
          {
            point_index: 0,
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: '读取返回 evt_real_01。',
            source_refs: [evidenceRef(0, '/event_id', 'value')],
          },
        ],
        request_coverage: [
          { request_unit_index: 0, status: 'answerable', evidence_point_indices: [0] },
        ],
        trace_coverage: [
          {
            call_index: 0,
            relevance: 'material',
            request_unit_indices: [0],
            evidence_point_indices: [0],
            rationale_md: 'event id 直接回答请求。',
          },
        ],
        safe_reply: 'event id 是 evt_real_01。',
      },
      requestUnits,
      toolTrace,
    });
    const replyUnits = segmentEvidenceReply('---');
    expect(() =>
      bindCopilotEvidenceComparison({
        value: {
          protocol_version: 1,
          reply_checks: [
            {
              reply_unit_index: 0,
              status: 'supported',
              evidence_point_indices: [0],
              source_refs: [],
              reason_codes: ['supported'],
            },
          ],
          request_checks: [
            {
              request_unit_index: 0,
              status: 'answered',
              reply_unit_indices: [0],
              evidence_point_indices: [0],
              reason_codes: ['supported'],
            },
          ],
        },
        requestUnits,
        replyUnits,
        selectedReplySha256: '0'.repeat(64),
        reference,
        toolTrace,
        sourceComplete: true,
      }),
    ).toThrow('syntax-only reply unit cannot carry material evidence');

    const result = bindCopilotEvidenceComparison({
      value: {
        protocol_version: 1,
        reply_checks: [
          {
            reply_unit_index: 0,
            status: 'supported',
            evidence_point_indices: [],
            source_refs: [],
            reason_codes: ['non_evidentiary'],
          },
        ],
        request_checks: [
          {
            request_unit_index: 0,
            status: 'answered',
            reply_unit_indices: [0],
            evidence_point_indices: [0],
            reason_codes: ['supported'],
          },
        ],
      },
      requestUnits,
      replyUnits,
      selectedReplySha256: '2'.repeat(64),
      reference,
      toolTrace,
      sourceComplete: true,
    });

    expect(result).toMatchObject({
      verdict: 'fail',
      violations: ['requested_chain_incomplete'],
    });
  });

  it.each([
    '-',
    '*',
    '+',
    '1.',
    '2)',
    '#',
    '######',
    '>',
    '> >',
    '```',
    '```ts',
    '~~~json',
    '```\n```',
    '[]()',
    '<!-- hidden comparator carrier -->',
    '<span></span>',
    '&nbsp;',
    '\u200B',
  ])('rejects another empty rendered Markdown carrier: %j', (replyText) => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验 event id。' });
    const toolTrace = [
      {
        name: 'query_events',
        effect: 'read' as const,
        input: { limit: 1 },
        output: { event_id: 'evt_real_01' },
        error_reason: null,
        executed: true,
      },
    ];
    const reference = bindCopilotEvidenceReference({
      value: {
        protocol_version: 1,
        evidence_points: [
          {
            point_index: 0,
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: '读取返回 evt_real_01。',
            source_refs: [evidenceRef(0, '/event_id', 'value')],
          },
        ],
        request_coverage: [
          { request_unit_index: 0, status: 'answerable', evidence_point_indices: [0] },
        ],
        trace_coverage: [
          {
            call_index: 0,
            relevance: 'material',
            request_unit_indices: [0],
            evidence_point_indices: [0],
            rationale_md: 'event id 直接回答请求。',
          },
        ],
        safe_reply: 'event id 是 evt_real_01。',
      },
      requestUnits,
      toolTrace,
    });
    const replyUnits = segmentEvidenceReply(replyText);
    expect(replyUnits.every((unit) => unit.syntax_only)).toBe(true);

    expect(() =>
      bindCopilotEvidenceComparison({
        value: {
          protocol_version: 1,
          reply_checks: replyUnits.map((unit) => ({
            reply_unit_index: unit.index,
            status: 'supported',
            evidence_point_indices: [0],
            source_refs: [],
            reason_codes: ['supported'],
          })),
          request_checks: [
            {
              request_unit_index: 0,
              status: 'answered',
              reply_unit_indices: replyUnits.map((unit) => unit.index),
              evidence_point_indices: [0],
              reason_codes: ['supported'],
            },
          ],
        },
        requestUnits,
        replyUnits,
        selectedReplySha256: '5'.repeat(64),
        reference,
        toolTrace,
        sourceComplete: true,
      }),
    ).toThrow('syntax-only reply unit cannot carry material evidence');
  });

  it('keeps visible list, heading, quote, and code content reviewable', () => {
    const units = segmentEvidenceReply(
      ['- event evt_01', '# Queue coverage', '> Unknown beyond exact filter', 'const x = 1'].join(
        '\n',
      ),
    );
    expect(units).toHaveLength(4);
    expect(units.every((unit) => unit.syntax_only === false)).toBe(true);
  });

  it('does not let a Markdown separator disclose an actual gap', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验完整队列。' });
    const toolTrace = [
      {
        name: 'get_review_due',
        effect: 'read' as const,
        input: { limit: 100 },
        output: { completeness: 'unknown' },
        error_reason: null,
        executed: true,
      },
    ];
    const reference = bindCopilotEvidenceReference({
      value: {
        protocol_version: 1,
        evidence_points: [
          {
            point_index: 0,
            request_unit_indices: [0],
            kind: 'actual_gap',
            statement_md: '当前 reader 不保证完整 queue coverage。',
            source_refs: [evidenceRef(0, '/completeness', 'coverage')],
          },
        ],
        request_coverage: [
          { request_unit_index: 0, status: 'actual_gap', evidence_point_indices: [0] },
        ],
        trace_coverage: [
          {
            call_index: 0,
            relevance: 'material',
            request_unit_indices: [0],
            evidence_point_indices: [0],
            rationale_md: 'coverage 字段直接界定无法裁决的范围。',
          },
        ],
        safe_reply: '当前无法裁决完整队列。',
      },
      requestUnits,
      toolTrace,
    });
    const replyUnits = segmentEvidenceReply('---');

    expect(() =>
      bindCopilotEvidenceComparison({
        value: {
          protocol_version: 1,
          reply_checks: [
            {
              reply_unit_index: 0,
              status: 'explicit_gap',
              evidence_point_indices: [0],
              source_refs: [],
              reason_codes: ['actual_gap_disclosed'],
            },
          ],
          request_checks: [
            {
              request_unit_index: 0,
              status: 'explicit_gap',
              reply_unit_indices: [0],
              evidence_point_indices: [0],
              reason_codes: ['actual_gap_disclosed'],
            },
          ],
        },
        requestUnits,
        replyUnits,
        selectedReplySha256: '3'.repeat(64),
        reference,
        toolTrace,
        sourceComplete: true,
      }),
    ).toThrow('syntax-only reply unit cannot disclose a gap');
  });

  it('preserves observed facts while explicitly disclosing the remaining request gap', () => {
    const requestUnits = segmentEvidenceRequest({ user_message: '核验激活事件及其原因。' });
    const toolTrace = [
      {
        name: 'get_attempt_context',
        effect: 'read' as const,
        input: { event_id: 'evt_activated_01' },
        output: { event_id: 'evt_activated_01', activation_policy: 'not_observed' },
        error_reason: null,
        executed: true,
      },
    ];
    const reference = bindCopilotEvidenceReference({
      value: {
        protocol_version: 1,
        evidence_points: [
          {
            point_index: 0,
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: '直接观测到 evt_activated_01。',
            source_refs: [evidenceRef(0, '/event_id', 'value')],
          },
          {
            point_index: 1,
            request_unit_indices: [0],
            kind: 'actual_gap',
            statement_md: '激活原因未被 reader 观测。',
            source_refs: [evidenceRef(0, '/activation_policy', 'scope')],
          },
        ],
        request_coverage: [
          { request_unit_index: 0, status: 'actual_gap', evidence_point_indices: [0, 1] },
        ],
        trace_coverage: [
          {
            call_index: 0,
            relevance: 'material',
            request_unit_indices: [0],
            evidence_point_indices: [0, 1],
            rationale_md: '同一 typed read 同时提供事件事实与原因边界。',
          },
        ],
        safe_reply: '已读到 evt_activated_01；但激活原因当前不可裁决。',
      },
      requestUnits,
      toolTrace,
    });
    const replyUnits = segmentEvidenceReply('已读到 evt_activated_01；但激活原因当前不可裁决。');
    const result = bindCopilotEvidenceComparison({
      value: {
        protocol_version: 1,
        reply_checks: [
          {
            reply_unit_index: 0,
            status: 'supported',
            evidence_point_indices: [0],
            source_refs: [],
            reason_codes: ['supported'],
          },
          {
            reply_unit_index: 1,
            status: 'explicit_gap',
            evidence_point_indices: [1],
            source_refs: [],
            reason_codes: ['actual_gap_disclosed'],
          },
        ],
        request_checks: [
          {
            request_unit_index: 0,
            status: 'explicit_gap',
            reply_unit_indices: [0, 1],
            evidence_point_indices: [0, 1],
            reason_codes: ['actual_gap_disclosed'],
          },
        ],
      },
      requestUnits,
      replyUnits,
      selectedReplySha256: '4'.repeat(64),
      reference,
      toolTrace,
      sourceComplete: true,
    });

    expect(result).toMatchObject({ verdict: 'pass', violations: [] });
  });

  it('binds dense request/reply indices and real RFC6901 pointers', () => {
    const requestUnits = segmentEvidenceRequest(reviewParams().requestContext);
    const reference = bindCopilotEvidenceReference({
      value: realisticReferenceOutput({ request_units: requestUnits }),
      requestUnits,
      toolTrace: REALISTIC_EVIDENCE_TRACE,
    });
    const replyUnits = segmentEvidenceReply(blindSafeReply);
    const comparison = bindCopilotEvidenceComparison({
      value: realisticComparisonOutput(
        {
          request_units: requestUnits,
          reply_units: replyUnits,
          sealed_reference: reference.output,
        },
        { unsafe: false },
      ),
      requestUnits,
      replyUnits,
      selectedReplySha256: 'a'.repeat(64),
      reference,
      toolTrace: REALISTIC_EVIDENCE_TRACE,
      sourceComplete: true,
    });

    expect(comparison.verdict).toBe('pass');
  });

  it('rejects a nonexistent pointer instead of trusting model-authored evidence text', () => {
    const requestUnits = segmentEvidenceRequest(reviewParams().requestContext);
    const invalid = referenceOutput({ request_units: requestUnits });
    const firstPoint = invalid.evidence_points[0];
    const firstRef = firstPoint?.source_refs[0];
    if (!firstRef) throw new Error('fixture source ref missing');
    firstRef.json_pointer = '/events/999/id';

    expect(() =>
      bindCopilotEvidenceReference({
        value: invalid,
        requestUnits,
        toolTrace: REALISTIC_EVIDENCE_TRACE,
      }),
    ).toThrow('pointer');
  });

  it('keeps 110 realistic Markdown units dense and rejects more than 192', () => {
    const rows = Array.from(
      { length: 110 },
      (_, index) =>
        `| ${index} | event_${index} | 2026-08-02T00:${String(index % 60).padStart(2, '0')}:00Z | value=${index} |`,
    );
    const units = segmentEvidenceReply(rows.join('\n'));
    expect(units).toHaveLength(110);
    expect(units.map((unit) => unit.index)).toEqual(Array.from({ length: 110 }, (_, i) => i));
    expect(() =>
      segmentEvidenceReply(Array.from({ length: 193 }, () => 'claim').join('\n')),
    ).toThrow('192');
  });
});
