import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';

let _client: ReturnType<typeof postgres> | undefined;
let _db: Db | undefined;
let _transactionClient: postgres.ReservedSql | undefined;
let _transactionDb: Db | undefined;
let _savepointId = 0;

type ScopedTransactionCallback = (client: postgres.TransactionSql) => unknown | Promise<unknown>;

function installTransactionShim(reserved: postgres.ReservedSql): void {
  const shim = reserved as unknown as {
    begin: (
      optionsOrCallback: string | ScopedTransactionCallback,
      callback?: ScopedTransactionCallback,
    ) => Promise<unknown>;
    savepoint: (
      nameOrCallback: string | ScopedTransactionCallback,
      callback?: ScopedTransactionCallback,
    ) => Promise<unknown>;
  };

  const withSavepoint = async (callback: ScopedTransactionCallback): Promise<unknown> => {
    const name = `vitest_test_tx_${++_savepointId}`;
    await reserved.unsafe(`SAVEPOINT "${name}"`);
    try {
      const result = await callback(reserved as unknown as postgres.TransactionSql);
      await reserved.unsafe(`RELEASE SAVEPOINT "${name}"`);
      return result;
    } catch (error) {
      // Preserve the application error if savepoint cleanup itself fails. The
      // outer afterEach ROLLBACK remains the authoritative cleanup and will
      // surface a broken/lost connection separately.
      await reserved
        .unsafe(`ROLLBACK TO SAVEPOINT "${name}"`)
        .then(() => reserved.unsafe(`RELEASE SAVEPOINT "${name}"`))
        .catch((cleanupError) => {
          console.error('Test transaction savepoint cleanup failed', cleanupError);
        });
      throw error;
    }
  };

  const resolveCallback = (
    first: string | ScopedTransactionCallback,
    second?: ScopedTransactionCallback,
  ): ScopedTransactionCallback => {
    const callback = typeof first === 'function' ? first : second;
    if (!callback) throw new Error('Test transaction callback is required');
    return callback;
  };

  // A Drizzle db built directly on a ReservedSql sees a top-level session and
  // calls client.begin() for db.transaction(). The reserved runtime client does
  // not expose begin/savepoint, so map both to savepoints inside the test's
  // already-open outer transaction.
  shim.begin = (first, second) => {
    if (typeof first === 'string') {
      return Promise.reject(
        new Error('Test transaction savepoints do not support postgres-js begin options'),
      );
    }
    return withSavepoint(resolveCallback(first, second));
  };
  shim.savepoint = (first, second) => withSavepoint(resolveCallback(first, second));
}

export function testDb(): Db {
  if (_transactionDb) return _transactionDb;
  if (_db) return _db;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — globalSetup did not run');
  _client = postgres(url, { max: 4 });
  _db = drizzle(_client, { schema }) as unknown as Db;
  return _db;
}

/**
 * Opt-in fast isolation for DB tests whose queries all flow through testDb().
 *
 * Do not use this for tests that need committed state to be visible from another
 * connection (routes importing the production db singleton, pg-boss, advisory
 * locks, raw postgres clients, or explicit concurrency tests). Those tests must
 * keep resetDb() isolation. PostgreSQL sequences are non-transactional, so tests
 * that assert RESTART IDENTITY values must also keep resetDb().
 */
export async function beginTestTransaction(): Promise<void> {
  if (_transactionClient) {
    throw new Error('A test transaction is already active in this Vitest worker');
  }

  // Initialize the shared pool before reserving one of its physical connections.
  testDb();
  const client = _client;
  if (!client) throw new Error('Test database pool was not initialized');
  const reserved = await client.reserve();

  try {
    await reserved.unsafe('BEGIN');
    // postgres-js' ReservedSql runtime object omits `options` even though its
    // public type extends Sql. Drizzle reads parser/serializer options while
    // constructing the session, so expose the owning pool's options here. Each
    // reserve() call creates a fresh Sql(handler) wrapper, so these wrapper
    // properties do not survive release() or mutate the physical pool connection.
    reserved.options = client.options;
    installTransactionShim(reserved);
    const transactionDb = drizzle(reserved, { schema }) as unknown as Db;
    _transactionClient = reserved;
    _transactionDb = transactionDb;
  } catch (error) {
    try {
      await reserved.unsafe('ROLLBACK').catch((rollbackError) => {
        console.error('beginTestTransaction: cleanup ROLLBACK failed', rollbackError);
      });
    } finally {
      reserved.release();
    }
    throw error;
  }
}

export async function rollbackTestTransaction(): Promise<void> {
  const reserved = _transactionClient;
  if (!reserved) return;

  // Clear the routing pointers before releasing the connection so a cleanup
  // failure cannot leave later tests bound to a released client.
  _transactionClient = undefined;
  _transactionDb = undefined;

  try {
    await reserved.unsafe('ROLLBACK');
  } finally {
    reserved.release();
  }
}

// Truncate all known tables, used for full-reset hermetic isolation.
// CASCADE handles FK dependencies; whitelist of identifiers (not user input).
// Phase 1c.1 Step 9.J: mistake / review_event / dreaming_proposal /
// ingestion_session DROPped — removed from this list. Step 1.4: judgment +
// user_appeal previously dropped per data-assumptions §O2.
const ALL_TABLES = [
  'note_verification_claim',
  'provider_attempt_admission',
  'provider_attempt',
  // YUK-842 — operational provider query-session leases/start-window rows (loose refs).
  'provider_session_admission',
  'copilot_evidence_checkpoint',
  'placement_starter_cost_component',
  'placement_starter_attempt_question',
  'placement_starter_attempt',
  'placement_starter_claim',
  // YUK-751 — derived subscription recovery state; child tables precede checkpoint/event.
  'event_subscription_effect',
  'event_subscription_delivery',
  'event_subscription_checkpoint',
  // YUK-791 — versioned intervention state is loose-ref only, so reset explicitly.
  'intervention',
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
  // YUK-531 (A5 S4 / RT1) — misconception-edge reconcile AUDIT log. No FK, so resetDb
  // must list it explicitly or it leaks across tests (same footgun as edge_reconciliation_log).
  'misconception_reconciliation_log',
  // YUK-143 / ADR-0024 — North-Star goal entity.
  'goal',
  'question_block',
  // YUK-350 — immutable generation plan + answer-anchor authored data.
  'question_generation_binding',
  'question_generation_plan',
  'question_answer_anchor',
  'question',
  'source_document',
  'source_asset',
  'knowledge',
  'ai_task_runs',
  'tool_operation',
  'tool_call_log',
  'cost_ledger',
  // YUK-599 (v3 trait 合同 §2.2) — subject 控制面六表。loose text-ref 无 FK，
  // 必须显式列入 TRUNCATE，否则 resetDb 漏清 → 跨测 state 泄漏（同 mastery_state
  // 一族的 footgun）。测试若需 builtin 种子行，须自行调 reconcileBuiltinTraits。
  'subject',
  'subject_trait',
  'subject_trait_journal',
  'subject_trait_binding',
  'subject_control_journal',
  'subject_name_claim',
  // YUK-758 — 夜间任务编排 DAG 调度运行态（run 头 + 逐节点态）。loose text-ref 无 FK，
  // 必须显式列入 TRUNCATE，否则 resetDb 漏清 → 跨测 state 泄漏（同 mastery_state 一族的
  // footgun：orchestrator DB 测试跨用例复用 RUN_DATE，漏清会让上一用例的 run 被下一用例采纳）。
  'dag_orchestration_run',
  'dag_orchestration_node',
] as const;

export async function resetDb() {
  if (_transactionClient) {
    throw new Error('resetDb() cannot run inside an active test transaction');
  }
  const db = testDb();
  // One statement preserves the same whitelist + RESTART IDENTITY semantics while
  // avoiding one network round-trip (and one cascade-NOTICE burst) per table. Every
  // Vitest fork owns an isolated database, so taking the complete TRUNCATE lock set
  // atomically cannot contend with another test file.
  const tables = ALL_TABLES.map((table) => `"${table}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`));
}
