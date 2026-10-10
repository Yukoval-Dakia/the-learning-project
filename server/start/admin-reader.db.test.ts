import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticsPublicSnapshot } from '@/capabilities/observability/server/diagnostics-read-test-helpers';
import type { Db, Tx } from '@/db/client';
import {
  ai_task_runs,
  cost_ledger,
  event,
  kc_typed_state,
  knowledge,
  learning_item,
  tool_call_log,
} from '@/db/schema';
import { resetDb, testDb } from '../../tests/helpers/db';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartAdmin } from './admin-read';
import type { createStartAdminReader } from './admin-reader';

// Connection ownership only. Every SQL query, canonical reader and HTTP handler is real.
vi.mock('@/db/client', async () => {
  const { testDb } = await import('../../tests/helpers/db');
  return {
    get db() {
      return testDb();
    },
  };
});
const now = new Date('2026-10-08T02:00:01.456Z');
const runId = 'start-admin-rich-run';
type Reader = Awaited<ReturnType<typeof createStartAdminReader>>;
const request = (token?: string) =>
  new Request('http://isolated.test/_serverFn/admin', {
    headers: token === undefined ? {} : { 'x-internal-token': token },
  });
const context = () => ({ api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }) });
async function seed(database: Db | Tx) {
  await database.insert(ai_task_runs).values([
    {
      id: runId,
      task_kind: 'AnalysisTask',
      provider: 'test',
      model: 'fixture',
      input_hash: 'hash:original',
      status: 'failure',
      finish_reason: 'tool_error',
      usage_json: {
        inputTokens: 12000,
        outputTokens: 987,
        d18_score: { points_awarded: 1, max_points: 3 },
      },
      cost_usd: null,
      cost_basis: 'unknown',
      cost_ref: 'unpriced:fixture',
      error_message: 'Ambiguous evidence\n'.repeat(100),
      started_at: new Date(now.getTime() - 1333),
      finished_at: now,
    },
    {
      id: 'start-admin-running',
      task_kind: 'RunningTask',
      provider: 'test',
      model: 'fixture',
      input_hash: 'hash:running',
      status: 'running',
      started_at: now,
      finished_at: null,
    },
  ]);
  await database.insert(cost_ledger).values([
    {
      id: 'start-admin-unknown-ledger',
      task_run_id: runId,
      task_kind: 'AnalysisTask',
      provider: 'test',
      model: 'fixture',
      cost: null,
      currency: 'USD',
      entry_kind: 'attempt',
      cost_basis: 'unknown',
      cost_ref: 'unpriced:fixture',
      tokens_in: 12000,
      tokens_out: 987,
      outcome: 'failure',
      pgboss_job_id: null,
      occurred_at: now,
    },
    {
      id: 'start-admin-legacy-ledger',
      task_run_id: runId,
      task_kind: 'AnalysisTask',
      provider: 'test',
      model: 'fixture',
      cost: 0.25,
      currency: 'CNY',
      tokens_in: 100,
      tokens_out: 20,
      outcome: 'success',
      pgboss_job_id: 'job-original',
      occurred_at: now,
    },
  ]);
  await database.insert(tool_call_log).values({
    id: 'start-admin-tool',
    task_run_id: runId,
    task_kind: 'AnalysisTask',
    tool_name: 'read_evidence',
    input_json: {
      long: '条件、失败与歧义。'.repeat(100),
      nested: { alternatives: [null, true] },
    },
    output_json: { records: [{ id: 'original', evidence: ['one', 'two'] }] },
    iteration: 3,
    latency_ms: 123.5,
    cost: 0,
    occurred_at: new Date(now.getTime() - 500),
  });
  await database.insert(knowledge).values(
    ['kc-start-a', 'kc-start-b'].map((id) => ({
      id,
      name: id,
      domain: 'math',
      created_at: now,
      updated_at: now,
    })),
  );
  await database.insert(learning_item).values({
    id: 'start-admin-open-item',
    source: 'test',
    title: 'active scope',
    content: '',
    knowledge_ids: ['kc-start-a'],
    status: 'pending',
    created_at: now,
    updated_at: now,
  });
  await database.insert(kc_typed_state).values({
    id: 'start-admin-typed',
    subject_kind: 'knowledge',
    subject_id: 'kc-start-a',
    typed_state: 'confused-with-X',
    confused_with_kc_id: 'kc-start-b',
    lifecycle: 'open',
    evidence_event_ids: ['probe-start', 'failure-start'],
    last_evidence_at: null,
    updated_at: now,
  });
  await database.insert(event).values([
    {
      id: 'start-admin-score',
      actor_kind: 'system',
      actor_ref: 'reconcile',
      action: 'experimental:prediction_score',
      subject_kind: 'event',
      subject_id: 'probe-start',
      outcome: 'success',
      created_at: now,
      ingest_at: now,
      payload: {
        conjecture_event_id: 'conjecture-start',
        probe_result_event_id: 'probe-start',
        knowledge_id: 'kc-start-a',
        predicted_p: 0.7,
        baseline_p: 0.5,
        outcome: 0,
        resolution: 'evidence_for',
        brier_model: 0.49,
        brier_baseline: 0.25,
        log_loss_model: null,
        skill_score_point: null,
        retrievability_at_judge: null,
      },
    },
    {
      id: 'start-admin-bad-score',
      actor_kind: 'system',
      actor_ref: 'reconcile',
      action: 'experimental:prediction_score',
      subject_kind: 'event',
      subject_id: 'probe-bad',
      outcome: 'success',
      created_at: now,
      ingest_at: now,
      payload: { predicted_p: 'bad', nested: { original: ['ambiguous', null] } },
    },
  ]);
}
beforeEach(async () => {
  vi.stubEnv('INTERNAL_TOKEN', 'isolated-admin-token');
  await resetDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('authenticated Start admin with real injected database', () => {
  it('reads the supplied uncommitted transaction, denies before operations, and leaves no persisted fixture after rollback', async () => {
    const rollback = new Error('intentional isolated rollback');
    await expect(
      testDb().transaction(async (database) => {
        await seed(database);
        const before = await diagnosticsPublicSnapshot(database);
        const call = vi.fn((r: Reader) => r.getRuns());
        const denied: unknown = await runAuthenticatedStartAdmin(
          context(),
          request('wrong'),
          call,
          { database, now },
        ).catch((error: unknown) => error);
        expect(denied).toBeInstanceOf(Response);
        expect(call).not.toHaveBeenCalled();
        const read = <T>(op: (r: Reader) => Promise<T>) =>
          runAuthenticatedStartAdmin(context(), request('isolated-admin-token'), op, {
            database,
            now,
          });
        expect((await read((r) => r.getRuns())).total).toBe(2);
        expect((await read((r) => r.getRunDetail({ id: runId }))).ledger).toHaveLength(2);
        expect((await read((r) => r.getCost())).days).toHaveLength(2);
        expect((await read((r) => r.getFailures())).clusters).toHaveLength(1);
        expect((await read((r) => r.getCoverage())).totals.activeKcs).toBe(1);
        expect((await read((r) => r.getConjectureScores())).typed_states).toHaveLength(1);
        const outside = await runAuthenticatedStartAdmin(
          context(),
          request('isolated-admin-token'),
          (r) => r.getRuns(),
          { database: testDb(), now },
        );
        expect(outside.total).toBe(0);
        expect(await diagnosticsPublicSnapshot(database)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await testDb().select().from(ai_task_runs)).toEqual([]);
    expect(await testDb().select().from(knowledge)).toEqual([]);
  });
});
