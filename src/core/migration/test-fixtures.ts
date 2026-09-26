import { AttemptQuestionSnapshot } from '../schema/question-evidence-snapshot';
import type { MigrationCapture, RawEventRow } from './types';

// YUK-1048 — shared capture fixtures for the pure migration unit tests.
// 纯对象构造器：不 import DB；db 侧的 capture.db.test.ts 自行 seed 真表。
// 快照 fixture 用【真实冻结契约】AttemptQuestionSnapshot.parse 产出（review
// P1-5：不能用 {prompt_md, kind} 这种自造形状掩盖校验缺口）。

export function emptyCapture(): MigrationCapture {
  return {
    capture_schema_version: 1,
    environment: {
      snapshot_at: '2026-09-25T00:00:00.000Z',
      db_server_version: '17.0',
      database_name: 'loom_test',
      host_fingerprint: 'abc123def456',
      migrations_applied: 42,
      pgboss_schema_present: false,
      isolation: 'repeatable read read only',
    },
    rawFacts: {
      events: [],
      fsrs: [],
      mastery: [],
      kc_typed: [],
      axis: [],
      item_calibration: [],
      family_calibration: [],
      difficulty_labels: [],
      selection_observations: [],
      answers: [],
      sessions: [],
      learning_record_mirrors: [],
      question_lineage: [],
      source_assets: [],
      event_action_counts: [],
      projection_baseline: {},
      aggregate_counts: { source_documents: 0, question_image_refs_total: 0 },
    },
    ops: {
      event_ingest_at: [],
      state_updated_at_max: {},
      state_version_max: {},
    },
    queues: [],
    subscription_checkpoints: [],
    subscription_deliveries: [],
    ai_task_runs: [],
  };
}

export interface EventFixture {
  id?: string;
  action?: string;
  subject_kind?: string;
  subject_id?: string;
  outcome?: string | null;
  payload?: Record<string, unknown>;
  caused_by_event_id?: string | null;
  session_id?: string | null;
  dispatch_seq?: number;
  created_at?: string;
  actor_kind?: string;
  actor_ref?: string;
}

export function ev(fixture: EventFixture): RawEventRow {
  return {
    id: fixture.id ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
    dispatch_seq: fixture.dispatch_seq ?? 1,
    session_id: fixture.session_id ?? null,
    actor_kind: fixture.actor_kind ?? 'user',
    actor_ref: fixture.actor_ref ?? 'self',
    action: fixture.action ?? 'attempt',
    subject_kind: fixture.subject_kind ?? 'question',
    subject_id: fixture.subject_id ?? 'q-1',
    outcome: fixture.outcome ?? 'failure',
    payload: fixture.payload ?? {},
    caused_by_event_id: fixture.caused_by_event_id ?? null,
    affected_scopes: [],
    task_run_id: null,
    cost_micro_usd: null,
    created_at: fixture.created_at ?? '2026-09-20T00:00:00.000Z',
  };
}

export function judgeEvent(fixture: EventFixture): RawEventRow {
  return ev({
    action: 'judge',
    subject_kind: 'event',
    outcome: 'success',
    actor_kind: 'agent',
    ...fixture,
  });
}

/** 真实冻结契约形状的 attempt issued snapshot（AttemptQuestionSnapshot.parse 产出）。 */
export const SNAPSHOT = AttemptQuestionSnapshot.parse({
  schema_version: 1,
  question: {
    question_id: 'q-1',
    question_version: 0,
    parent_question_id: null,
    prompt_md: '1+1=?',
    reference_md: '2',
    choices_md: null,
    image_refs: [],
    figures: [],
    updated_at: '2026-09-01T00:00:00.000Z',
  },
  parent_question: null,
});

/**
 * 真实 durable pending 输入的冻结 snapshot（FrozenQuestionSnapshot 结构，
 * judge-run-payload.ts）：kind/prompt_md/.../version/updated_at。
 */
export const FROZEN_DURABLE_SNAPSHOT = {
  kind: 'short_answer',
  prompt_md: '1+1=?',
  reference_md: '2',
  rubric_json: null,
  choices_md: null,
  judge_kind_override: null,
  knowledge_ids: ['kc-1'],
  difficulty: 3,
  metadata: null,
  figures: [],
  image_refs: [],
  structured: null,
  version: 0,
  updated_at: '2026-09-01T00:00:00.000Z',
} as const;

/** durable pending 事件（JudgePendingAttemptPayload 形状，含真实 submit 冻结输入）。 */
export function durablePendingEvent(fixture: {
  id: string;
  runId: string;
  questionId?: string;
  responseMd?: string;
  withSnapshot?: boolean;
  /** 覆盖冻结 snapshot（终轮 P1-1 repro：4 字段残缺快照）。 */
  snapshotOverride?: unknown;
}): RawEventRow {
  return ev({
    id: fixture.id,
    action: 'experimental:judge_pending_attempt',
    subject_kind: 'question',
    subject_id: fixture.questionId ?? 'q-1',
    outcome: null,
    payload: {
      run_id: fixture.runId,
      caller: 'submit',
      knowledge_ids: ['kc-1'],
      ability_global_ids: ['ag-1'],
      submit: {
        body: { response_md: fixture.responseMd ?? 'x' },
        question_id: fixture.questionId ?? 'q-1',
        // JudgePendingSubmitInput 必填字段（契约面）：subject_profile + ability 上下文。
        subject_profile: { learner_id: 'learner-1', locale: 'zh' },
        ability_global_by_knowledge_id: { 'kc-1': 'ag-1' },
        submitted_at: '2026-09-20T00:00:00.000Z',
        ...(fixture.snapshotOverride !== undefined
          ? { question_snapshot: fixture.snapshotOverride }
          : fixture.withSnapshot === false
            ? {}
            : { question_snapshot: { ...FROZEN_DURABLE_SNAPSHOT } }),
      },
    },
  });
}

/** review-settlement 形状的 answer-bearing review（user_response_md + embedded judge）。 */
export function answeredReviewEvent(fixture: {
  id: string;
  questionId?: string;
  responseMd?: string;
  withVerdict?: boolean;
  judgeRoute?: string;
}): RawEventRow {
  return ev({
    id: fixture.id,
    action: 'review',
    subject_kind: 'question',
    subject_id: fixture.questionId ?? 'q-1',
    outcome: 'success',
    payload: {
      fsrs_rating: 'good',
      user_response_md: fixture.responseMd ?? '2',
      answer_image_refs: [],
      referenced_knowledge_ids: ['kc-1'],
      ...(fixture.withVerdict === false
        ? {}
        : {
            judge: {
              route: fixture.judgeRoute ?? 'exact',
              score: 1,
              score_meaning: 'correctness',
              coarse_outcome: 'correct',
              confidence: 0.9,
              feedback_md: '答对了',
              evidence_json: {},
              capability_ref: { id: 'exact', version: '1.0.0' },
              suggested_rating: 'good',
              auto_rated: true,
            },
          }),
    },
  });
}

export function withEvents(capture: MigrationCapture, events: RawEventRow[]): MigrationCapture {
  return {
    ...capture,
    rawFacts: { ...capture.rawFacts, events },
  };
}
