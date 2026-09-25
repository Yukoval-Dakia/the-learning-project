import type { MigrationCapture, RawEventRow } from './types';

// YUK-1048 — shared capture fixtures for the pure migration unit tests.
// 纯对象构造器：不 import DB；db 侧的 capture.db.test.ts 自行 seed 真表。

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

export const SNAPSHOT = { prompt_md: '1+1=?', kind: 'short_answer' } as const;

export function withEvents(capture: MigrationCapture, events: RawEventRow[]): MigrationCapture {
  return {
    ...capture,
    rawFacts: { ...capture.rawFacts, events },
  };
}
