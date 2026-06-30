import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

let _client: ReturnType<typeof postgres> | undefined;
let _db: Db | undefined;

export function testDb(): Db {
  if (_db) return _db;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — globalSetup did not run');
  _client = postgres(url, { max: 4 });
  _db = drizzle(_client, { schema }) as unknown as Db;
  return _db;
}

// Truncate all known tables, used in beforeEach for hermetic tests.
// CASCADE handles FK dependencies; whitelist of identifiers (not user input).
// Phase 1c.1 Step 9.J: mistake / review_event / dreaming_proposal /
// ingestion_session DROPped — removed from this list. Step 1.4: judgment +
// user_appeal previously dropped per data-assumptions §O2.
const ALL_TABLES = [
  'event',
  'proposal_signals',
  'material_fsrs_state',
  // B1-W1 (ADR-0035) — diagnostic projection (θ̂/p(L)) + item difficulty anchor.
  'mastery_state',
  // YUK-440 (A13) — typed KC ledger projection. No FK, so resetDb must list it
  // explicitly or it leaks across tests (same footgun as mastery_state /
  // materialized_id_index).
  'kc_typed_state',
  // YUK-445 (A11) — per-KC caution / speed-accuracy axis descriptor. No FK; list
  // explicitly or it leaks across tests (same footgun as kc_typed_state above).
  'learner_axis_state',
  'item_calibration',
  // YUK-361 Phase 5 — 家族级 b_delta 慢热校准资产。
  'item_family_calibration',
  // YUK-361 Phase 6 — active-PPI 难度重标定标签账本（无 FK，须显式列入 TRUNCATE，
  // 否则 resetDb 漏清 → 跨测 state 泄漏；当前仅靠 unique question id 遮掩，Codex P2）。
  'difficulty_calibration_label',
  // YUK-471 W1 PR-A2a — projection reverse-index (materialized id → anchor event).
  // No FK, so resetDb must list it explicitly or it leaks across tests (same
  // footgun as difficulty_calibration_label above).
  'materialized_id_index',
  'knowledge_edge',
  // YUK-531 (A5 S4 / RT1) — misconception identity + heterogeneous edge. No FK, so
  // resetDb must list them explicitly or they leak across tests (same footgun as
  // mastery_state / kc_typed_state). `misconception` was missing here while dormant;
  // it MUST be listed now that the promotion writer gives it a write path.
  'misconception',
  'misconception_edge',
  'learning_session',
  'answer',
  'completion_evidence',
  'memory_brief_note',
  'learning_record',
  'artifact',
  'learning_item',
  'mistake_variant',
  // M2 (YUK-316) — 练习流日程表。
  'practice_stream_item',
  // YUK-361 Phase 1（观测先行）— 选题逐项遥测（π_i 慢热资产）。
  'selection_observation',
  // YUK-321 M5 gate 选项 b — editing presence 跨进程状态机表。
  'editing_presence',
  // YUK-342 P2 — memory reconcile write-ahead log.
  'memory_reconciliation_log',
  // YUK-344 增量 2 / ADR-0034 §3 — knowledge-edge reconcile write-ahead log.
  'edge_reconciliation_log',
  // YUK-143 / ADR-0024 — North-Star goal entity.
  'goal',
  'question_block',
  'question',
  'source_document',
  'source_asset',
  'knowledge',
  'ai_task_runs',
  'tool_call_log',
  'cost_ledger',
] as const;

export async function resetDb() {
  const db = testDb();
  for (const t of ALL_TABLES) {
    await db.execute(sql.raw(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`));
  }
}
