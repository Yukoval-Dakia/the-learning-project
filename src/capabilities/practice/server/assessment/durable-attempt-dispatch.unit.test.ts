import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeJudgePendingSubmitInput } from '@/core/schema/event/judge-pending-events';
import { db } from '@/db/client';
import type { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { authorizeJudgeSend, reserveInitialJudgeDelivery } from '../judge-operational';
import { admitJudgeRun, enqueueJudgeRun, refundJudgeRunAdmission } from '../judge-run-dispatch';
import { projectJudgeRunNotification } from '../judge-run-notification';
import { recordFormalAttemptCapture } from './attempt';
import { dispatchNativeAttempt } from './durable-attempt';

type PendingRow = typeof event.$inferSelect;
const state = vi.hoisted(() => ({
  pending: undefined as PendingRow | undefined,
  failure: 'none' as 'none' | 'before-read' | 'commit-ack',
  transactions: 0,
}));
vi.mock('@/db/client', () => {
  const tx = { select: () => ({ from: () => ({ where: async () => [state.pending] }) }) };
  return {
    db: {
      transaction: vi.fn(async (body: (database: typeof tx) => Promise<unknown>) => {
        state.transactions++;
        if (state.transactions === 1 && state.failure === 'before-read')
          throw new Error('controlled transaction unavailable before read');
        const result = await body(tx);
        if (state.transactions === 1 && state.failure === 'commit-ack')
          throw new Error('controlled replay COMMIT acknowledgement lost');
        return result;
      }),
    },
  };
});
vi.mock('./attempt', () => ({
  prepareFormalAttemptSubmission: vi.fn(async () => ({
    submission: {
      submission_id: 'sub_frozen',
      evaluation_group_id: 'group_frozen',
      issuance_id: 'issued_frozen',
      revision_id: 'revision_frozen',
      idempotency_key: 'answer_frozen',
      submitted_at: '2026-10-08T12:34:56.789Z',
      response_set: {
        entries: [{ slot_id: 'equations', kind: 'text', text_md: 'v+c=18; v-c=12; 2v=30' }],
      },
      group_evidence: [],
    },
    revision: {
      execution_plan: {
        assignments: [{ executor: { kind: 'model_executor' }, scoring_unit_ids: ['speed'] }],
      },
    },
    scopedUnitIds: new Set(['speed']),
  })),
  recordFormalAttemptCapture: vi.fn(() => {
    throw new Error('replay must not recapture');
  }),
}));
vi.mock('@/kernel/events', () => ({
  writeEvent: vi.fn(() => {
    throw new Error('replay must not write');
  }),
}));
vi.mock('../judge-operational', () => ({
  readJudgeControl: vi.fn(async () => ({ phase: 'pg-boss' })),
  lockJudgeRun: vi.fn(async () => {}),
  reserveInitialJudgeDelivery: vi.fn(() => {
    throw new Error('replay must not reserve');
  }),
  authorizeJudgeSend: vi.fn(() => {
    throw new Error('replay must not authorize');
  }),
}));
vi.mock('../judge-run-dispatch', () => ({
  JUDGE_PENDING_ATTEMPT_ACTION: 'experimental:judge_pending_attempt',
  admitJudgeRun: vi.fn(() => {
    throw new Error('replay must not consume an admission');
  }),
  refundJudgeRunAdmission: vi.fn(() => {
    throw new Error('retained original must not refund');
  }),
  enqueueJudgeRun: vi.fn(() => {
    throw new Error('replay must not enqueue');
  }),
}));
vi.mock('../judge-run-notification', () => ({
  projectJudgeRunNotification: vi.fn(() => {
    throw new Error('replay must not project');
  }),
}));
vi.mock('../judge-run-observation', () => ({}));
vi.mock('../judge-run-payload', () => ({}));

const submittedAt = '2026-10-08T12:34:56.789Z';
const runId = 'judge_native_sub_frozen';
const request = {
  issuance_id: 'issued_frozen',
  evaluation_group_id: 'group_frozen',
  idempotency_key: 'answer_frozen',
  response_set: {
    entries: [
      {
        slot_id: 'equations',
        kind: 'text' as const,
        text_md: 'v+c=18; v-c=12; 2v=30.\n消元与单位保持一致。\n'.repeat(30),
      },
    ],
  },
  // A retry clock is not the frozen answer clock.
  now: new Date('2026-10-09T01:30:00.000Z'),
};
function fixture() {
  const submit = NativeJudgePendingSubmitInput.parse({
    question_id: 'question_frozen',
    submission_id: 'sub_frozen',
    evaluation_group_id: 'group_frozen',
    submitted_at: submittedAt,
    expected_head: { expected_effective_id: null, expected_generation: 0 },
    user_rating: 'hard',
    require_unassisted_model_evidence: true,
    capture: {
      session_id: 'session_original',
      stream_item_id: 'stream_original',
      latency_ms: 321,
      reasoning_trace: 'v+c=18、v-c=12，逐步消元。\n'.repeat(20),
      ingestion: {
        block_id: 'block_original',
        block_version: 2,
        source_document_id: 'document_original',
        source_asset_ids: ['image_1', 'image_2'],
        generated_by: 'workflow_judge',
      },
    },
  });
  const row: PendingRow = {
    id: `evt_pending_${runId}`,
    dispatch_seq: 101,
    action: 'experimental:judge_pending_attempt',
    session_id: submit.capture.session_id ?? null,
    actor_kind: 'user',
    actor_ref: 'self',
    subject_kind: 'question',
    subject_id: submit.question_id,
    outcome: null,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    affected_scopes: [],
    created_at: new Date(submittedAt),
    // This marker may change independently of the immutable original.
    ingest_at: new Date('2026-10-09T01:29:00.000Z'),
    payload: {
      run_id: runId,
      caller: 'native_assessment',
      knowledge_ids: [],
      ability_global_ids: [],
      submit,
    },
  };
  const options = {
    enabled: false,
    userRating: submit.user_rating,
    requireUnassistedModelEvidence: submit.require_unassisted_model_evidence,
    capture: { latency_ms: 999, session_id: 'retry_session', reasoning_trace: 'retry metadata' },
  };
  state.pending = row;
  return { row, submit, options };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.transactions = 0;
  state.failure = 'none';
});
afterEach(() => vi.restoreAllMocks());
function expectNoEffects() {
  for (const operation of [
    writeEvent,
    recordFormalAttemptCapture,
    admitJudgeRun,
    refundJudgeRunAdmission,
    reserveInitialJudgeDelivery,
    authorizeJudgeSend,
    enqueueJudgeRun,
    projectJudgeRunNotification,
  ]) {
    expect(operation).not.toHaveBeenCalled();
  }
}

it.each(['none', 'before-read', 'commit-ack'] as const)(
  'reuses the exact frozen original with disabled flag and changed capture after %s',
  async (failure) => {
    const f = fixture();
    const before = structuredClone(f.row);
    state.failure = failure;
    await expect(dispatchNativeAttempt(db, 'question_frozen', request, f.options)).resolves.toBe(
      runId,
    );
    expect(state.pending).toEqual(before);
    expect(state.transactions).toBe(failure === 'none' ? 1 : 2);
    expectNoEffects();
  },
);

it.each(['rating', 'unassisted-policy'])(
  'cannot recover a rejected %s change as success',
  async (change) => {
    const f = fixture();
    const before = structuredClone(f.row);
    const options =
      change === 'rating'
        ? { ...f.options, userRating: 'again' as const }
        : { ...f.options, requireUnassistedModelEvidence: false };
    await expect(
      dispatchNativeAttempt(db, 'question_frozen', request, options),
    ).rejects.toMatchObject({
      code: 'coordinate_mismatch',
    });
    expect(state.pending).toEqual(before);
    expect(state.transactions).toBe(2);
    expectNoEffects();
  },
);

const corruptions = [
  {
    name: 'run',
    change: (f) => ({ ...f.row, payload: { ...f.row.payload, run_id: 'other_run' } }),
  },
  {
    name: 'submission',
    change: (f) => ({
      ...f.row,
      payload: { ...f.row.payload, submit: { ...f.submit, submission_id: 'other_sub' } },
    }),
  },
  {
    name: 'group',
    change: (f) => ({
      ...f.row,
      payload: { ...f.row.payload, submit: { ...f.submit, evaluation_group_id: 'other_group' } },
    }),
  },
  {
    name: 'question',
    change: (f) => ({
      ...f.row,
      payload: { ...f.row.payload, submit: { ...f.submit, question_id: 'other_question' } },
    }),
  },
  {
    name: 'answer time',
    change: (f) => ({
      ...f.row,
      payload: {
        ...f.row.payload,
        submit: { ...f.submit, submitted_at: '2026-10-09T01:00:00.000Z' },
      },
    }),
  },
  {
    name: 'initial head',
    change: (f) => ({
      ...f.row,
      payload: {
        ...f.row.payload,
        submit: {
          ...f.submit,
          expected_head: { expected_effective_id: 'current_candidate', expected_generation: 1 },
        },
      },
    }),
  },
  { name: 'action', change: (f) => ({ ...f.row, action: 'experimental:other' }) },
  { name: 'actor', change: (f) => ({ ...f.row, actor_kind: 'agent' }) },
  { name: 'actor reference', change: (f) => ({ ...f.row, actor_ref: 'other_actor' }) },
  { name: 'subject kind', change: (f) => ({ ...f.row, subject_kind: 'submission' }) },
  { name: 'subject', change: (f) => ({ ...f.row, subject_id: 'other_question' }) },
  { name: 'session', change: (f) => ({ ...f.row, session_id: 'other_session' }) },
  { name: 'outcome', change: (f) => ({ ...f.row, outcome: 'success' }) },
  { name: 'cause', change: (f) => ({ ...f.row, caused_by_event_id: 'other_cause' }) },
  { name: 'task', change: (f) => ({ ...f.row, task_run_id: 'other_task' }) },
  { name: 'cost', change: (f) => ({ ...f.row, cost_micro_usd: 10 }) },
  {
    name: 'event time',
    change: (f) => ({ ...f.row, created_at: new Date('2026-10-09T01:00:00.000Z') }),
  },
] satisfies { name: string; change: (f: ReturnType<typeof fixture>) => PendingRow }[];
it.each(corruptions)('fails closed on a conflicting $name in both reads', async ({ change }) => {
  for (const failure of ['none', 'before-read'] as const) {
    const f = fixture();
    state.transactions = 0;
    state.failure = failure;
    const corrupt = change(f);
    const before = structuredClone(corrupt);
    state.pending = corrupt;
    await expect(
      dispatchNativeAttempt(db, 'question_frozen', request, f.options),
    ).rejects.toBeInstanceOf(ApiError);
    expect(state.pending).toEqual(before);
    expect(state.transactions).toBe(2);
    expectNoEffects();
  }
});

it('fails closed on a structurally corrupt pending payload', async () => {
  const f = fixture();
  state.pending = { ...f.row, payload: { run_id: runId, caller: 'native_assessment', submit: {} } };
  await expect(dispatchNativeAttempt(db, 'question_frozen', request, f.options)).rejects.toThrow();
  expect(state.transactions).toBe(2);
  expectNoEffects();
});
